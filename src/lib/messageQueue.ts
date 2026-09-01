export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private isProcessing = false;

  /**
   * Enqueues a new user message/task prompt.
   * Returns the enqueued item or null if empty.
   */
  enqueue(text: string): QueuedMessage | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const item: QueuedMessage = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: trimmed,
      timestamp: Date.now(),
    };

    this.queue.push(item);
    return item;
  }

  /**
   * Dequeues the next message in FIFO order.
   */
  dequeue(): QueuedMessage | null {
    if (this.queue.length === 0) return null;
    return this.queue.shift() || null;
  }

  /**
   * Peeks the next message without removing it.
   */
  peek(): QueuedMessage | null {
    return this.queue[0] || null;
  }

  /**
   * Returns a copy of all queued items.
   */
  getAll(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Returns all queued texts as a string array for persistence.
   */
  getAllTexts(): string[] {
    return this.queue.map((q) => q.text);
  }

  /**
   * Returns current count of queued messages.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Returns true if queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clears all items in the queue.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Removes item at specified 0-based index.
   */
  removeAt(index: number): QueuedMessage | null {
    if (index < 0 || index >= this.queue.length) return null;
    const removed = this.queue.splice(index, 1);
    return removed[0] || null;
  }

  /**
   * Updates/edits text of an item at index.
   */
  updateAt(index: number, newText: string): boolean {
    if (index < 0 || index >= this.queue.length) return false;
    const trimmed = newText.trim();
    if (!trimmed) return false;
    this.queue[index].text = trimmed;
    return true;
  }

  /**
   * Reorders an item from fromIndex to toIndex.
   */
  reorder(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.queue.length) return false;
    if (toIndex < 0 || toIndex >= this.queue.length) return false;
    if (fromIndex === toIndex) return true;

    const [item] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, item);
    return true;
  }

  /**
   * Moves item up by 1 position.
   */
  moveUp(index: number): boolean {
    if (index <= 0 || index >= this.queue.length) return false;
    return this.reorder(index, index - 1);
  }

  /**
   * Moves item down by 1 position.
   */
  moveDown(index: number): boolean {
    if (index < 0 || index >= this.queue.length - 1) return false;
    return this.reorder(index, index + 1);
  }

  /**
   * Restores queue items from an array of strings or QueuedMessages.
   */
  restore(items: (string | QueuedMessage)[]): void {
    this.queue = [];
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (typeof item === "string") {
        if (item.trim()) {
          this.enqueue(item);
        }
      } else if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) {
        this.queue.push({
          id: item.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          text: item.text.trim(),
          timestamp: item.timestamp || Date.now(),
        });
      }
    }
  }

  /**
   * State check if foreground agent task is currently executing.
   */
  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  setIsProcessing(val: boolean): void {
    this.isProcessing = val;
  }
}

export const messageQueue = new MessageQueue();
