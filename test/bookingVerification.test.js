import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailDomainPattern, getBookingVerificationError } from '../src/bookingVerification.js'

test('booking verification requires a verified email and honors organization domain rules', () => {
  const organization = { bookingVerification: { requiredEmailDomain: 'clinic.example.org' } }
  assert.match(getBookingVerificationError({ email: 'person@clinic.example.org', emailVerified: false }, organization), /Verify your email/)
  assert.match(getBookingVerificationError({ email: 'person@example.org', emailVerified: true }, organization), /clinic\.example\.org/)
  assert.equal(getBookingVerificationError({ email: 'PERSON@CLINIC.EXAMPLE.ORG', emailVerified: true }, organization), '')
  assert.equal(getBookingVerificationError({ email: 'person@example.org', emailVerified: true }, {}), '')
})

test('booking verification requires organization-selected profile details and explains how to fix them', () => {
  const organization = {
    bookingVerification: {
      requiredProfileFields: ['admissionId', 'department'],
    },
  }
  const user = { email: 'student@example.org', emailVerified: true }
  assert.match(getBookingVerificationError(user, organization), /Admission ID, Department.*Profile/)
  assert.match(
    getBookingVerificationError(user, organization, { admissionId: 'A-1024', department: 'Engineering' }),
    /^$/,
  )
  assert.match(
    getBookingVerificationError(user, { bookingVerification: { requiredProfileFields: ['unknown'] } }),
    /invalid profile verification settings/,
  )
})

test('email domain patterns escape regular expression punctuation', () => {
  assert.equal(emailDomainPattern('clinic.example.org'), 'clinic\\.example\\.org')
})
