// ── Service Errors ──

export class ServiceNotFoundError extends Error {
  public readonly serviceId: string;
  constructor(serviceId: string) {
    super(`Service "${serviceId}" not found`);
    this.name = "ServiceNotFoundError";
    this.serviceId = serviceId;
  }
}

export class ServiceInitializationError extends Error {
  public readonly serviceId: string;
  constructor(serviceId: string, message: string, options?: { cause?: Error }) {
    super(`[${serviceId}] ${message}`, options);
    this.name = "ServiceInitializationError";
    this.serviceId = serviceId;
  }
}

// ── Tool Errors ──

export class ToolNotFoundError extends Error {
  public readonly toolId: string;
  constructor(toolId: string) {
    super(`Tool "${toolId}" not found`);
    this.name = "ToolNotFoundError";
    this.toolId = toolId;
  }
}

export class ToolExecutionError extends Error {
  public readonly toolId: string;
  constructor(toolId: string, message: string, options?: { cause?: Error }) {
    super(`[Tool:${toolId}] ${message}`, options);
    this.name = "ToolExecutionError";
    this.toolId = toolId;
  }
}
