export class OperationBusyError extends Error {
  constructor(operation) {
    super(`启动器正在执行“${operation}”，请稍后再试。`);
    this.name = 'OperationBusyError';
    this.code = 'OPERATION_BUSY';
    this.status = 409;
  }
}

export class AsyncOperationLock {
  #active = null;

  get activeOperation() { return this.#active; }
  get locked() { return Boolean(this.#active); }

  async run(operation, action) {
    if (this.#active) throw new OperationBusyError(this.#active);
    this.#active = String(operation || '未知操作');
    try { return await action(); }
    finally { this.#active = null; }
  }
}
