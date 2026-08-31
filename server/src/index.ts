import { buildApp } from "./app.js";
import { Executor } from "./core/executor.js";
import { KeyPool } from "./core/keyPool.js";
import { ModelRouter } from "./core/router.js";
import { createDefaultProviderRegistry } from "./providers/registry.js";
import { loadEnv } from "./env.js";
import { sweepExpired } from "./media/b64cache.js";
import { openDb } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { pruneExpiredGenerationHistory } from "./store/retention.js";
import { seedIfEmpty, seedAdminIfEmpty } from "./store/seed.js";
import { JobManager } from "./server/jobs.js";
import path from "node:path";

const env = loadEnv();
const db = openDb(env.dataDir);
const repo = new Repo(db);
seedIfEmpty(env.dataDir, repo);

const seeded = seedAdminIfEmpty(repo, env);
if (seeded.created) {
  console.info(`created initial admin ${seeded.email} (from ADMIN_EMAIL/ADMIN_PASSWORD)`);
}

const router = new ModelRouter(repo);
const keyPool = new KeyPool(repo);
const providers = createDefaultProviderRegistry();
const executor = new Executor({ router, keyPool, providers, repo });
const jobManager = new JobManager();

// 内存 job 随进程消失，遗留的 pending 历史记录标记为失败
const restarted = repo.failPendingGenerations("server restarted");
if (restarted > 0) console.info(`marked ${restarted} pending generations as failed (server restarted)`);

const app = await buildApp({
  env,
  repo,
  router,
  keyPool,
  providers,
  executor,
  jobManager,
  logger: true,
  webDist: path.resolve(import.meta.dirname, "../../web/dist"),
});

// 每小时独立清理生成图（24h）和历史记录（7d）
const sweep = (): void => {
  const sweptImages = sweepExpired(env.dataDir, 24 * 3600_000);
  if (sweptImages > 0) app.log.info(`swept ${sweptImages} expired generated images`);

  const sweptHistory = pruneExpiredGenerationHistory(repo);
  if (sweptHistory > 0) app.log.info(`swept ${sweptHistory} expired generation records`);
};
sweep();
setInterval(sweep, 3600_000).unref();

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`tiny-images listening on http://0.0.0.0:${env.port} (data: ${env.dataDir})`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    repo.close();
    process.exit(0);
  });
}
