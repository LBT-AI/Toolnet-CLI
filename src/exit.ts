let destroyFn: (() => void) | null = null;

export function setDestroyFn(fn: () => void) {
  destroyFn = fn;
}

export function exitTui() {
  if (destroyFn) {
    destroyFn();
  } else {
    process.exit(0);
  }
}
