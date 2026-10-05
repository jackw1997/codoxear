/** Docker-only scripted provider endpoint. Uses fixture credentials exclusively. */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type GatewayRequest = {
  path: string;
  model: unknown;
  authorized: boolean;
};
export async function backendGateway(port = 19821) {
  if (!existsSync("/.dockerenv")) throw new Error("Docker only");
  const requests: GatewayRequest[] = [],
    marker = "PRIVATE_PROVIDER_OK";
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(requests));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || "{}"),
      path = req.url ?? "/";
    requests.push({
      path,
      model: payload.model,
      authorized:
        req.headers.authorization === "Bearer fixture-private-key" ||
        req.headers["x-api-key"] === "fixture-private-key",
    });
    if (path.includes("count_tokens")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (path.split("?")[0]!.endsWith("/chat/completions")) {
      for (const data of [
        {
          id: "chat-1",
          object: "chat.completion.chunk",
          model: "PrivateModel",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: marker },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chat-1",
          object: "chat.completion.chunk",
          model: "PrivateModel",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.write("data: [DONE]\n\n");
    } else if (path.split("?")[0]!.endsWith("/messages")) {
      const events: Array<[string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg-1",
              type: "message",
              role: "assistant",
              model: "PrivateModel",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: marker },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      for (const [event, data] of events) send(event, data);
    } else if (path.split("?")[0]!.endsWith("/responses")) {
      const item = {
        type: "message",
        id: "msg-1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: marker, annotations: [] }],
      };
      const response = {
        id: "resp-1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "PrivateModel",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      const events: Array<[string, Record<string, unknown>]> = [
        [
          "response.created",
          { response: { ...response, status: "in_progress", output: [] } },
        ],
        [
          "response.output_item.added",
          {
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
        ],
        [
          "response.content_part.added",
          {
            output_index: 0,
            item_id: "msg-1",
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
        ],
        [
          "response.output_text.delta",
          {
            output_index: 0,
            item_id: "msg-1",
            content_index: 0,
            delta: marker,
          },
        ],
        [
          "response.output_text.done",
          { output_index: 0, item_id: "msg-1", content_index: 0, text: marker },
        ],
        ["response.output_item.done", { output_index: 0, item }],
        ["response.completed", { response }],
      ];
      events.forEach(([event, data], sequence_number) =>
        send(event, { type: event, sequence_number, ...data }),
      );
    } else res.write("data: {}\n\n");
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    requests,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await backendGateway();
