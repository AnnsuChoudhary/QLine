export const BOOKING_PROFILE_FIELDS = Object.freeze({
  admissionId: 'Admission ID',
  employeeId: 'Employee ID',
  department: 'Department',
})

export function getBookingVerificationError(user, organization, profile = {}) {
  if (!user?.emailVerified) {
    return 'Verify your email address before joining a queue or booking. You can resend the verification link from your profile.'
  }

  const requiredEmailDomain = organization?.bookingVerification?.requiredEmailDomain
  if (typeof requiredEmailDomain === 'string' && requiredEmailDomain.trim()) {
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
    const domain = requiredEmailDomain.trim().toLowerCase()
    if (!email.endsWith(`@${domain}`)) {
      return `This organization accepts verified email addresses from ${domain}.`
    }
  }

  const requiredProfileFields = organization?.bookingVerification?.requiredProfileFields ?? []
  if (!Array.isArray(requiredProfileFields)
    || requiredProfileFields.some((field) => !Object.hasOwn(BOOKING_PROFILE_FIELDS, field))) {
    return 'This organization has invalid profile verification settings. Contact its administrator.'
  }
  const missingFields = requiredProfileFields.filter((field) => (
    typeof profileValue(profile, field) !== 'string' || !profileValue(profile, field).trim()
  ))
  if (missingFields.length) {
    const labels = missingFields.map((field) => BOOKING_PROFILE_FIELDS[field]).join(', ')
    return `Complete ${labels} in your Profile before booking.`
  }

  return ''
}

function profileValue(profile, field) {
  return profile?.[field]
}

export function emailDomainPattern(domain) {
  return domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
