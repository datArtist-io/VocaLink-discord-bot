/** Fixed-capacity FIFO that drops the oldest items when full. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private len = 0;
  dropped = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.items = new Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  push(item: T): void {
    const idx = (this.head + this.len) % this.capacity;
    if (this.len === this.capacity) {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else {
      this.items[idx] = item;
      this.len++;
    }
  }

  shift(): T | undefined {
    if (!this.len) return undefined;
    const it = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.len--;
    return it;
  }

  drain(): T[] {
    const out: T[] = [];
    while (this.len) out.push(this.shift() as T);
    return out;
  }

  clear(): void {
    this.drain();
  }
}
