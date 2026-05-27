/**
 * BullMQ processor for message sending jobs.
 * Imported by the worker's index.js as a Worker processor.
 */

/**
 * @param {import('bullmq').Job} job
 * @param {import('../InstanceManager.js').InstanceManager} manager
 */
export async function processMessage(job, manager) {
  const { instanceId, type, messages, delayMs } = job.data;

  // Bulk job
  if (type === undefined && messages) {
    const results = [];
    for (const msg of messages) {
      const instance = manager.instances.get(instanceId);
      if (!instance) throw new Error(`Instance ${instanceId} not found`);
      try {
        const result = await instance.sendMessage(msg);
        results.push({ ...result, to: msg.to, status: 'sent' });
      } catch (err) {
        results.push({ to: msg.to, status: 'failed', error: err.message });
      }
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
    return { results };
  }

  // Single message
  const instance = manager.instances.get(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not loaded in worker`);

  const result = await instance.sendMessage(job.data);
  return result;
}
