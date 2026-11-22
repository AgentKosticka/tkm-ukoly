export class BusyError extends Error {
  constructor() {
    super('Server je teď vytížený, zkuste to prosím za chvíli');
    this.statusCode = 503;
    this.code = 'busy';
  }
}

/** Omezí počet souběžně běžících úloh; fronta čekajících má pevný strop. */
export class Semaphore {
  #free;
  #waiting = [];
  #maxQueue;

  constructor(concurrency, maxQueue = Infinity) {
    this.#free = concurrency;
    this.#maxQueue = maxQueue;
  }

  async run(task) {
    if (this.#free > 0) {
      this.#free -= 1;
    } else {
      if (this.#waiting.length >= this.#maxQueue) throw new BusyError();
      await new Promise((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}
