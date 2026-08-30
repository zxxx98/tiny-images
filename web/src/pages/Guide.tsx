import { useEffect, useState } from "react";

/**
 * API 调用引导页：向调用方展示 Base URL、鉴权方式与生图接口的完整调用示例。
 * Base URL 取当前页面地址，方便部署后直接复制。
 */
export default function Guide() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const baseUrl = origin || "https://your-deployed-host";
  const curl = `curl -X POST ${baseUrl}/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的APIKey" \\
  -d '{
    "model": "你的对外model名",
    "prompt": "a cute robot in a 90s desktop, pixel art",
    "n": 1,
    "size": "1024x1024"
  }'`;
  const python = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="sk-你的APIKey",
)

resp = client.images.generate(
    model="你的对外model名",
    prompt="a cute robot in a 90s desktop, pixel art",
    n=1,
    size="1024x1024",
)
print(resp.data[0].url)`;
  const streamCurl = `curl -N -X POST ${baseUrl}/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-你的APIKey" \\
  -d '{"model": "你的对外model名", "prompt": "……", "stream": true}'

# SSE 帧格式：
# data: {"type":"progress","message":"生成中…"}
# data: {"type":"image","b64_json":"……","revised_prompt":"……"}
# data: [DONE]`;

  return (
    <div className="guide">
      <div className="guide-hero">
        <h1 className="rainbow">API 调用指南</h1>
        <p>三步接入 · OpenAI Images API 完全兼容 · <span className="badge-new">HOT!</span></p>
      </div>
      <hr className="hr-groove" />

      <div className="card">
        <h2>第 1 步 · 拿到 Base URL 与 API Key</h2>
        <p>
          本服务的 Base URL 是：
          <br />
          <code className="mono">{baseUrl}/v1</code>
        </p>
        <p>
          到 <a href="/admin">管理后台</a> 的「API Keys」页生成一个 Key（形如 <code className="mono">sk-…</code>）。
          未配置任何 Key 时，/v1 接口不启用鉴权——生产环境请务必至少建一个。
        </p>
      </div>

      <div className="card">
        <h2>第 2 步 · 查询可用模型（可选）</h2>
        <pre className="codeblock">{`GET ${baseUrl}/v1/models
Authorization: Bearer sk-你的APIKey`}</pre>
        <p>返回 <code className="mono">{"{ data: [{ id: \"model名\" }, …] }"}</code>，id 即可在生成接口中作为 model 参数使用。</p>
      </div>

      <div className="card">
        <h2>第 3 步 · 调用生图接口</h2>
        <p>
          接口：<code className="mono">POST /v1/images/generations</code>，请求与响应结构与 OpenAI Images API 一致。
          常用参数：<code className="mono">model</code>、<code className="mono">prompt</code>、<code className="mono">n</code>（1–10）、
          <code className="mono">size</code>（如 1024x1024）、<code className="mono">response_format</code>（url / b64_json）、
          <code className="mono">stream</code>。其余字段会原样透传给上游。
        </p>
        <h3>cURL</h3>
        <pre className="codeblock">{curl}</pre>
        <h3>OpenAI Python SDK</h3>
        <pre className="codeblock">{python}</pre>
        <p className="muted">
          提示：把 SDK 的 <code className="mono">base_url</code> 指向 <code className="mono">{baseUrl}/v1</code> 即可无缝切换，其余代码不用改。
        </p>
      </div>

      <div className="card">
        <h2>进阶 · 流式生成（SSE）</h2>
        <p>
          请求体加 <code className="mono">"stream": true</code>，服务端会以 SSE 逐帧推送进度与图片，适合长耗时任务。
        </p>
        <pre className="codeblock">{streamCurl}</pre>
        <p className="muted">
          响应头 <code className="mono">x-tiny-channel</code> 会标明本次命中的上游渠道，便于排查路由。
        </p>
      </div>

      <div className="construction">
        <div>
          <strong>⚠ UNDER CONSTRUCTION：</strong> 更多接口（图片编辑 /v1/images/edits 等）文档编写中。遇到 401 检查 Authorization 头，遇到 404 检查 model 名是否已在后台建立映射。
        </div>
      </div>

      <div className="card">
        <h2>常见状态码</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>状态码</th>
                <th>含义</th>
                <th>排查建议</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">200</td>
                <td>成功</td>
                <td>—</td>
              </tr>
              <tr>
                <td className="mono">401</td>
                <td>API Key 无效或缺失</td>
                <td>检查 Authorization: Bearer 头</td>
              </tr>
              <tr>
                <td className="mono">404</td>
                <td>model 未映射</td>
                <td>到后台「模型映射」确认对外 model 名</td>
              </tr>
              <tr>
                <td className="mono">502 / 504</td>
                <td>上游错误或超时</td>
                <td>查看后台「请求日志」中的错误信息</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="color-squares" aria-hidden="true">
        <span style={{ background: "#ff0000" }} />
        <span style={{ background: "#00ff00" }} />
        <span style={{ background: "#0000ff" }} />
        <span style={{ background: "#ffff00" }} />
        <span style={{ background: "#ff00ff" }} />
        <span style={{ background: "#00ffff" }} />
      </div>
    </div>
  );
}
