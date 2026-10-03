type Listener<T> = (value: T) => void;

class BaseState<T> {
  private state: T;
  private revision = 0;
  private listeners: Listener<T>[] = [];

  constructor(initialValue: T) {
    this.state = initialValue;
  }

  onStateChanged(callback: Listener<T>) {
    this.listeners.push(callback);
  }

  offStateChanged(callback: Listener<T>) {
    const index = this.listeners.indexOf(callback);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  SetState(value: T) {
    this.revision++;
    if (this.state === value) return;
    this.state = value;
    this.listeners.forEach(listener => listener(value));
  }

  GetState(): T {
    return this.state;
  }

  GetRevision(): number {
    return this.revision;
  }
}

export class StateNumber extends BaseState<number> {
  constructor(initialValue = 0) {
    super(initialValue);
  }
}
