// Web Worker entry for the Moria Module. Native code enters moria_start once;
// every later main-thread exchange resolves the already-suspended Asyncify
// import through MoriaWorkerBridge and never re-enters WASM from onmessage.
import { MoriaWorkerBridge, type MoriaWorkerPost } from "./workerBridge";
import type { MoriaMainToWorker } from "./protocol";
import {
  mountMoriaStorage,
  type MoriaPersistHandle,
  type MoriaPersistModule,
} from "./persist";
import {
  MoriaPersistenceLifecycle,
  type MoriaQuitState,
} from "./persistenceLifecycle";
import { answerExportRequest, type ExportedSave } from "../../backplane/saveExport";
import { answerDescribeRequest } from "../../backplane/describe";
import {
  createMoriaSemanticReporter,
  type MoriaSemanticReporter,
} from "./semanticReporter";

export interface MoriaRuntimeModule {
  moriaPreExit?: unknown;
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    arguments_: unknown[],
    options?: Record<string, unknown>,
  ): unknown;
}

export type MoriaModuleFactory = (
  options: Record<string, unknown>,
) => Promise<MoriaRuntimeModule>;

export interface MoriaMessageLifecycle {
  readonly closing: boolean;
  deliverKey(deliver: () => void): boolean;
}

export interface MoriaExportHandle {
  exportSave(now: Date): ExportedSave;
}

export function handleMoriaWorkerMessage(
  message: MoriaMainToWorker,
  bridge: MoriaWorkerBridge,
  lifecycle: MoriaMessageLifecycle,
  currentPersist: () => MoriaExportHandle | undefined,
  post: MoriaWorkerPost,
  describer?: (x: number, y: number) => string | null,
): boolean | Promise<void> {
  if (message.type === "describe") {
    answerDescribeRequest(message, describer, (reply) => post(reply, []));
    return true;
  }
  if (message.type === "exportSave") {
    answerExportRequest(message.id, currentPersist(), (reply, transfer) =>
      post(reply, transfer));
    return true;
  }
  if (message.type === "key") {
    let handled = false;
    const delivered = lifecycle.deliverKey(() => {
      handled = bridge.handleMessage(message) === true;
    });
    return delivered && handled;
  }
  return bridge.handleMessage(message);
}

export interface MoriaRunCallbacks {
  semantic: MoriaSemanticReporter;
  checkpointCommand?(): boolean;
  checkpointLanded?(): Promise<boolean>;
  checkpointRecoveryPath?(): string;
  preRun?(module: MoriaPersistModule): void;
  /** The live module, published for the message handler: describe() is a
   *  read-only ccall made while the engine is parked on its input request. */
  engineReady?(module: MoriaRuntimeModule): void;
  ready(): void;
  quit(): void;
}

export interface MoriaTerminalReporter {
  readonly done: boolean;
  quit(state: MoriaQuitState): boolean;
  fatal(error: unknown): boolean;
}

/** First terminal outcome owns the Worker. Browser teardown can surface the
 * same ExitStatus through both the ccall and global rejection channels. */
export function createMoriaTerminalReporter(post: MoriaWorkerPost): MoriaTerminalReporter {
  let done = false;
  return {
    get done() { return done; },
    quit(state) {
      if (done) return false;
      done = true;
      post({ type: "quit", ...state });
      return true;
    },
    fatal(error: unknown) {
      if (done) return false;
      done = true;
      post({ type: "fatal", message: typeof error === "string" ? error : String(error) });
      return true;
    },
  };
}

/** Testable engine half of the Worker. The factory has completed runtime
 * initialization when it resolves, so ready is ordered before the one ccall. */
export async function runMoriaEngine(
  createMoriaModule: MoriaModuleFactory,
  bridge: MoriaWorkerBridge,
  coreDirectory: string,
  callbacks: MoriaRunCallbacks,
): Promise<void> {
  const module = await createMoriaModule({
    locateFile: (path: string) => coreDirectory + path,
    print: () => {},
    printErr: (text: string) => console.warn("[moria stderr]", text),
    terminalFlush: bridge.terminalFlush,
    terminalBell: bridge.terminalBell,
    getKeyInput: bridge.getKeyInput,
    beforeExit: bridge.beforeExit,
    checkpointCommand: callbacks.checkpointCommand ?? (() => false),
    checkpointLanded: callbacks.checkpointLanded ?? (async () => false),
    checkpointRecoveryPath: callbacks.checkpointRecoveryPath ?? (() => ""),
    semanticMap: callbacks.semantic.semanticMap,
    semanticState: callbacks.semantic.semanticState,
    semanticMessage: callbacks.semantic.semanticMessage,
    ...(callbacks.preRun ? { preRun: [callbacks.preRun] } : {}),
  });

  callbacks.engineReady?.(module);
  callbacks.ready();
  const result = await module.ccall(
    "moria_start",
    "number",
    ["number", "boolean"],
    [0, false],
    { async: true },
  );

  if (result === undefined && module.moriaPreExit === true) {
    callbacks.quit();
    return;
  }
  if (typeof result === "number") {
    throw new Error(`moria_start produced unexpected numeric return ${result}`);
  }
  if (result === undefined) {
    throw new Error("moria_start resolved without the pre-exit marker");
  }
  throw new Error(`moria_start produced unexpected return ${String(result)}`);
}

async function loadMoriaFactory(coreDirectory: string): Promise<MoriaModuleFactory> {
  const loaded = await import(/* @vite-ignore */ coreDirectory + "moria.js") as {
    default: MoriaModuleFactory;
  };
  return loaded.default;
}

export function startMoriaWorker(scope: DedicatedWorkerGlobalScope): void {
  const post: MoriaWorkerPost = (message, transfer = []) =>
    scope.postMessage(message, transfer);
  let persist: MoriaPersistHandle | undefined;
  let quitState: MoriaQuitState | undefined;
  const persistence = new MoriaPersistenceLifecycle(() => persist);
  const bridge = new MoriaWorkerBridge(post, {
    release: () => persistence.release(),
    beforeExit: async (_status, outcome) => {
      quitState = await persistence.beforeExit(outcome);
    },
  });
  const terminal = createMoriaTerminalReporter(post);
  const semantic = createMoriaSemanticReporter((ev, transfer) =>
    post({ type: "event", ev }, transfer));

  let engine: MoriaRuntimeModule | undefined;
  const describeCell = (x: number, y: number): string | null => {
    if (!engine) return null;
    const text = engine.ccall("moria_describe", "string", ["number", "number"], [x, y]);
    return typeof text === "string" && text ? text : null;
  };

  scope.onmessage = (event: MessageEvent<MoriaMainToWorker>) => {
    const handled = handleMoriaWorkerMessage(
      event.data, bridge, persistence, () => persist, post, describeCell,
    );
    if (handled instanceof Promise) void handled.catch((error) => terminal.fatal(error));
  };
  scope.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    terminal.fatal(event.reason);
  });
  scope.addEventListener("error", (event: ErrorEvent) => {
    terminal.fatal(event.error ?? event.message);
  });

  const coreDirectory = new URL(
    import.meta.env.BASE_URL + "modules/moria/",
    scope.location.origin,
  ).href;
  void loadMoriaFactory(coreDirectory)
    .then((factory) => runMoriaEngine(factory, bridge, coreDirectory, {
      semantic,
      checkpointCommand: persistence.checkpointCommand,
      checkpointLanded: persistence.checkpointLanded,
      checkpointRecoveryPath: persistence.checkpointRecoveryPath,
      preRun: (module) => { persist = mountMoriaStorage(module); },
      engineReady: (module) => { engine = module; },
      ready: () => post({ type: "ready" }),
      quit: () => {
        if (quitState === undefined) {
          terminal.fatal("Moria exited without finalized persistence state");
          return;
        }
        terminal.quit(quitState);
      },
    }))
    .catch((error) => terminal.fatal(error));
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  startMoriaWorker(self as DedicatedWorkerGlobalScope);
}
