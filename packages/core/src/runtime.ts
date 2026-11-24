import type { AppConfig } from "@myassistant/config";

export interface AssistantRuntime {
  readonly config: AppConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeSummary {
  env: AppConfig["app"]["env"];
  model: string;
  dingtalk: "enabled" | "disabled";
  rag: "enabled" | "disabled";
  daemon: "enabled" | "disabled";
  tasks: AppConfig["tasks"]["backend"];
}

export function describeRuntime(config: AppConfig): RuntimeSummary {
  return {
    env: config.app.env,
    model: `${config.model.provider}/${config.model.id}`,
    dingtalk: config.dingtalk.enabled ? "enabled" : "disabled",
    rag: config.rag.enabled ? "enabled" : "disabled",
    daemon: config.daemon.enabled ? "enabled" : "disabled",
    tasks: config.tasks.backend,
  };
}
