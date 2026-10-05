export class Queue {
  constructor({ maxConcurrent = 1, maxQueue = 3 } = {}) { this.maxConcurrent = maxConcurrent; this.maxQueue = maxQueue; this.active = 0; this.pending = [] }
  async run(work, signal) {
    if (signal?.aborted) throw signal.reason || new Error('请求已取消')
    if (this.active >= this.maxConcurrent) {
      if (this.pending.length >= this.maxQueue) throw new Error('当前请求较多，请稍后再试')
      await new Promise((resolve, reject) => {
        const item = { resolve: () => { signal?.removeEventListener('abort', abort); resolve() }, reject }
        const abort = () => { const index = this.pending.indexOf(item); if (index !== -1) this.pending.splice(index, 1); reject(signal.reason || new Error('请求已超时')) }
        this.pending.push(item); signal?.addEventListener('abort', abort, { once: true })
      })
    } else this.active++
    try { if (signal?.aborted) throw signal.reason; return await work() }
    finally { const next = this.pending.shift(); if (next) next.resolve(); else this.active-- }
  }
}
