const mutationQueues = new Map<string, Promise<void>>();

export async function withFileMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  const queued = current.then(() => undefined, () => undefined);
  mutationQueues.set(path, queued);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(path) === queued) mutationQueues.delete(path);
  }
}
