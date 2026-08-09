export interface HydrationTaskInput {
  id: string;
  position: number;
  priority?: number;
}

export interface HydrationTask {
  id: string;
  position: number;
  priority: number;
}

interface InternalHydrationTask extends HydrationTask {
  sequence: number;
}

export interface HydrationQueue {
  enqueue(task: HydrationTaskInput): void;
  next(centerPosition?: number): HydrationTask | null;
  evictOutside(maxDistance: number, centerPosition?: number): number;
  clear(): void;
  readonly size: number;
}

export function createHydrationQueue(): HydrationQueue {
  const tasks = new Map<string, InternalHydrationTask>();
  let sequence = 0;

  const distanceTo = (task: InternalHydrationTask, centerPosition: number): number =>
    Math.abs(task.position - centerPosition);

  return {
    enqueue(task) {
      const nextTask: InternalHydrationTask = {
        id: task.id,
        position: task.position,
        priority: task.priority ?? 0,
        sequence: ++sequence,
      };

      if (tasks.has(task.id)) {
        tasks.delete(task.id);
      }
      tasks.set(task.id, nextTask);
    },

    next(centerPosition = 0) {
      let best: InternalHydrationTask | null = null;

      for (const task of tasks.values()) {
        if (best === null) {
          best = task;
          continue;
        }

        const bestDistance = distanceTo(best, centerPosition);
        const taskDistance = distanceTo(task, centerPosition);
        const betterDistance = taskDistance < bestDistance;
        const betterPriority =
          taskDistance === bestDistance && task.priority > best.priority;
        const newerTask =
          taskDistance === bestDistance &&
          task.priority === best.priority &&
          task.sequence > best.sequence;

        if (betterDistance || betterPriority || newerTask) {
          best = task;
        }
      }

      if (best === null) {
        return null;
      }

      tasks.delete(best.id);
      return {
        id: best.id,
        position: best.position,
        priority: best.priority,
      };
    },

    evictOutside(maxDistance, centerPosition = 0) {
      let evicted = 0;
      for (const [id, task] of tasks) {
        if (distanceTo(task, centerPosition) > maxDistance) {
          tasks.delete(id);
          evicted += 1;
        }
      }
      return evicted;
    },

    clear() {
      tasks.clear();
    },

    get size() {
      return tasks.size;
    },
  };
}
