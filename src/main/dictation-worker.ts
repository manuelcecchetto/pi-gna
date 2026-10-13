// Dictation's speech model, in an Electron utility process (src/main/dictation): native code that crashes takes only
// this process down. Main passes the library, Koffi addon and model paths in the environment; the model loads once
// at start, then each message is one recording to transcribe, run one at a time.
import { TranscribeModel } from "transcribe-cpp";
import type { WorkerReply, WorkerRequest } from "./dictation";

const port = process.parentPort;
const post = (reply: WorkerReply) => port.postMessage(reply);

const loading = TranscribeModel.load(process.env.PIGNA_DICTATION_MODEL ?? "");
loading.then(
  () => post({ type: "ready" }),
  (error: Error) => post({ type: "failed", message: error.message }),
);

let queue: Promise<unknown> = Promise.resolve();
port.on("message", ({ data }: { data: WorkerRequest }) => {
  queue = queue.then(async () => {
    try {
      const model = await loading;
      const result = await model.transcribe(data.pcm);
      post({ type: "result", id: data.id, text: result.text });
    } catch (error) {
      post({ type: "error", id: data.id, message: (error as Error).message });
    }
  });
});
