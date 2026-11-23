export function validatePipelineDraft(name, queueIds, queues) {
  const normalizedName = typeof name === 'string' ? name.trim() : ''
  if (!normalizedName || normalizedName.length > 100) {
    throw new Error('Enter a pipeline name of 1 to 100 characters.')
  }
  if (!Array.isArray(queueIds) || queueIds.length < 2) {
    throw new Error('A pipeline must contain at least two queue steps.')
  }
  if (queueIds.length > 20) {
    throw new Error('A pipeline can contain no more than 20 queue steps.')
  }
  const availableQueueIds = new Set(queues.map((queue) => queue.id))
  if (queueIds.some((queueId) => !availableQueueIds.has(queueId))) {
    throw new Error('Remove queues that are no longer available and try again.')
  }
  return { name: normalizedName, queueIds }
}

export function getNextPipelineStep(pipeline, run) {
  if (!Array.isArray(pipeline?.queueIds)
    || !Number.isSafeInteger(run?.currentStep)
    || run.status !== 'ready'
    || run.currentStep < 1
    || run.currentStep >= pipeline.queueIds.length) {
    return null
  }
  return run.currentStep
}

export function getPipelineStepStatus(stepNumber, run) {
  if (!run) return stepNumber === 1 ? 'Available' : 'Locked'
  if (run?.status === 'concluded') return 'Stopped'
  if (run?.status === 'completed') return 'Completed'
  if (stepNumber < (run?.currentStep ?? 1)
    || (stepNumber === run?.currentStep && run?.status === 'ready')) return 'Completed'
  if (stepNumber === run?.currentStep && run?.status === 'active') return 'Active / Current'
  if (stepNumber === run?.currentStep + 1 && run?.status === 'ready') return 'Active / Current'
  return 'Locked'
}
