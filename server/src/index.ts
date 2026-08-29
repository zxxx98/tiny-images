import { buildApp } from "./app.js";
import { Executor } from "./core/executor.js";
import { KeyPool } from "./core/keyPool.js";
import { ModelRouter } from "./core/router.js";
import { OpenAICompatProvider } from "./providers/openai-compat.js";
import { loadEnv } from "./env.js";
import { sweepExpired } from "./media/b64cache.js";
import { openDb } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { seedIfEmpty } from "./store/seed.js";

const env = loadEnv();
const db = openDb(env.dataDir);
const repo = new Repo(db);
seedIfEmpty(env.dataDir, repo);

const router = new ModelRouter(repo);
const keyPool = new KeyPool(repo);
const provider = new OpenAICompatProvider();
const executor = new Executor({ router, keyPool, provider, repo });

const app = await buildApp({ env, repo, router, keyPool, provider, executor, logger: true });

// 每小时清理过期的生成图缓存（TTL 24h）
const sweep = (): void => {
  const swept = sweepExpired(env.dataDir, 24 * 3600_000);
  if (swept > 0) app.log.info(`swept ${swept} expired generated images`);
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
