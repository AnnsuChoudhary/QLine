import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getNextPipelineStep, getPipelineStepStatus, validatePipelineDraft } from '../src/pipelines.js'

const queues = [{ id: 'check-in' }, { id: 'interview' }, { id: 'offer' }]

test('pipeline drafts accept custom ordering, including repeated queues', () => {
  assert.deepEqual(validatePipelineDraft(' Campus Hiring ', ['check-in', 'interview'], queues), {
    name: 'Campus Hiring',
    queueIds: ['check-in', 'interview'],
  })
  assert.throws(() => validatePipelineDraft('Hiring', ['check-in'], queues), /at least two/)
  assert.throws(() => validatePipelineDraft('Hiring', Array(21).fill('check-in'), queues), /no more than 20/)
  assert.deepEqual(validatePipelineDraft('Hiring', ['check-in', 'check-in'], queues).queueIds, ['check-in', 'check-in'])
  assert.throws(() => validatePipelineDraft('Hiring', ['check-in', 'missing'], queues), /no longer available/)
})

test('pipeline progress only exposes the next sequential step after completion', () => {
  const pipeline = { queueIds: ['check-in', 'interview', 'offer'] }
  const activeRun = { status: 'active', currentStep: 1 }
  const readyRun = { status: 'ready', currentStep: 1 }
  assert.equal(getNextPipelineStep(pipeline, activeRun), null)
  assert.equal(getNextPipelineStep(pipeline, readyRun), 1)
  assert.equal(getPipelineStepStatus(1, readyRun), 'Completed')
  assert.equal(getPipelineStepStatus(2, readyRun), 'Active / Current')
  assert.equal(getPipelineStepStatus(3, readyRun), 'Locked')
  assert.equal(getNextPipelineStep(pipeline, { ...readyRun, currentStep: 3 }), null)
  assert.equal(getPipelineStepStatus(1, null), 'Available')
})
