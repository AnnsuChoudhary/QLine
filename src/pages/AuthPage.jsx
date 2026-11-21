import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  createUserWithEmailAndPassword,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth'
import { doc, getDoc, runTransaction, setDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from '../firebase/config.js'
import AppHeader from '../components/AppHeader.jsx'
import { useAuth } from '../context/useAuth.js'

const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
])
const categories = ['Clinic', 'Bank', 'Govt Office', 'Service Center']
const JOIN_CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeJoinCode() {
  const randomValues = crypto.getRandomValues(new Uint32Array(6))
  return Array.from(randomValues, (value) => JOIN_CODE_CHARACTERS[value % JOIN_CODE_CHARACTERS.length]).join('')
}

async function createOrganizationWithUniqueJoinCode(user, organization) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const joinCode = makeJoinCode()
    const orgRef = doc(db, 'organizations', user.uid)
    const userRef = doc(db, 'users', user.uid)
    const reservationRef = doc(db, 'joinCodes', joinCode)
    const slugReservationRef = doc(db, 'orgSlugs', organization.slug)
    const created = await runTransaction(db, async (transaction) => {
      const [reservation, slugReservation] = await Promise.all([
        transaction.get(reservationRef),
        transaction.get(slugReservationRef),
      ])
      if (reservation.exists() || slugReservation.exists()) return false

      transaction.set(reservationRef, { ownerUid: user.uid, orgId: user.uid })
      transaction.set(slugReservationRef, { ownerUid: user.uid, orgId: user.uid, slug: organization.slug })
      transaction.set(orgRef, { ...organization, joinCode })
      transaction.set(userRef, {
        name: user.displayName,
        email: user.email,
        role: 'org_admin',
        orgId: user.uid,
        joinedOrgs: [user.uid],
      })
      return true
    })
    if (created) return
  }
  throw new Error('Unable to generate a unique organization join code. Please try again.')
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function getCustomerDestination(location, searchParams) {
  if (location.state?.from?.startsWith('/')) return location.state.from
  const orgSlug = searchParams.get('org')
  return orgSlug ? `/org/${encodeURIComponent(orgSlug)}` : '/join'
}

export default function AuthPage({ mode }) {
  const navigate = useNavigate()
  const { firebaseUser, refreshProfile } = useAuth()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [role, setRole] = useState(searchParams.get('role') === 'organization' ? 'organization' : 'user')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [orgName, setOrgName] = useState('')
  const [category, setCategory] = useState(categories[0])
  const [address, setAddress] = useState('')
  const [registrationId, setRegistrationId] = useState('')
  const [error, setError] = useState(location.state?.verificationRequired ? 'Verify your email before opening the organization dashboard.' : '')
  const [notice, setNotice] = useState(
    location.state?.verificationRequired && firebaseUser
      ? `Verify your email before opening the organization dashboard. A link was sent to ${firebaseUser.email}.`
      : '',
  )
  const [verificationUser, setVerificationUser] = useState(
    location.state?.verificationRequired ? firebaseUser : null,
  )
  const [busy, setBusy] = useState(false)

  const emailDomain = email.trim().toLowerCase().split('@')[1]
  const publicDomainError = mode === 'register'
    && role === 'organization'
    && emailDomain
    && PUBLIC_DOMAINS.has(emailDomain)
    ? 'Organization Admin accounts must use an official business or institutional email address.'
    : ''

  const ensureUserProfile = async (credential) => {
    const userRef = doc(db, 'users', credential.user.uid)
    const existing = await getDoc(userRef)
    if (!existing.exists()) {
      await setDoc(userRef, {
        name: credential.user.displayName || name || 'QLine User',
        email: credential.user.email,
        role: 'user',
        joinedOrgs: [],
      })
    }
    return refreshProfile(credential.user.uid)
  }

  const showVerificationPrompt = (user, linkSent = false) => {
    setVerificationUser(user)
    setNotice(linkSent
      ? `We sent a verification link to ${user.email}. Verify your email before opening the organization dashboard.`
      : `Verify your email before opening the organization dashboard. You can resend the link to ${user.email}.`)
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    if (publicDomainError) {
      setError(publicDomainError)
      return
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        const credential = await signInWithEmailAndPassword(auth, email, password)
        const profile = await ensureUserProfile(credential)
        if (profile?.role === 'org_admin') {
          if (!credential.user.emailVerified) {
            showVerificationPrompt(credential.user)
            return
          }
          navigate('/dashboard')
          return
        }
        navigate(getCustomerDestination(location, searchParams))
        return
      }

      if (role === 'organization' && (!orgName.trim() || !address.trim() || !registrationId.trim())) {
        throw new Error('Organization name, official address/city, and registration/tax ID are required.')
      }

      const credential = await createUserWithEmailAndPassword(auth, email, password)
      await updateProfile(credential.user, { displayName: name.trim() })

      if (role === 'organization') {
        const domain = email.trim().toLowerCase().split('@')[1]
        const orgSlug = `${slugify(orgName) || 'organization'}-${credential.user.uid}`

        await createOrganizationWithUniqueJoinCode(credential.user, {
          name: orgName.trim(),
          slug: orgSlug,
          adminUid: credential.user.uid,
          officialEmail: email.trim().toLowerCase(),
          domain,
          category,
          address: address.trim(),
          registrationId: registrationId.trim(),
          status: 'pending',
          verificationStatus: 'pending',
          services: [],
          hours: {},
        })
        await refreshProfile(credential.user.uid)
        showVerificationPrompt(credential.user)
        await sendEmailVerification(credential.user)
        showVerificationPrompt(credential.user, true)
      } else {
        await setDoc(doc(db, 'users', credential.user.uid), {
          name: name.trim(),
          email: credential.user.email,
          role: 'user',
          joinedOrgs: [],
        })
        await refreshProfile(credential.user.uid)
        navigate(getCustomerDestination(location, searchParams))
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const googleSignIn = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const credential = await signInWithPopup(auth, googleProvider)
      await ensureUserProfile(credential)
      navigate(getCustomerDestination(location, searchParams))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const resendVerification = async () => {
    if (!verificationUser) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await sendEmailVerification(verificationUser)
      setNotice(`A new verification link was sent to ${verificationUser.email}.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const checkVerification = async () => {
    if (!verificationUser) return
    setBusy(true)
    setError('')
    try {
      await reload(verificationUser)
      if (!verificationUser.emailVerified) {
        setError('Your email is not verified yet. Open the link in your inbox, then try again.')
        return
      }
      setNotice('Email verified. Opening your organization dashboard…')
      navigate('/dashboard')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <AppHeader />
      <section className="auth-page">
        <div className="auth-card">
          <p className="eyebrow">{mode === 'register' ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</p>
          <h1>{mode === 'register' ? 'Join QLine' : 'Sign in to QLine'}</h1>
          <div className="role-toggle" role="tablist" aria-label="Account role">
            <button type="button" className={role === 'user' ? 'active' : ''} onClick={() => { setRole('user'); setError('') }}>Customer / User</button>
            <button type="button" className={role === 'organization' ? 'active' : ''} onClick={() => { setRole('organization'); setError('') }}>Organization Admin</button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' && <label>Your name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
            <label>Email address<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            {publicDomainError && <p className="form-error" role="alert">{publicDomainError}</p>}
            <label>Password<input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {mode === 'register' && role === 'organization' && (
              <>
                <label>Organization name<input required value={orgName} onChange={(event) => setOrgName(event.target.value)} /></label>
                <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
                <label>Official address / city<input required value={address} onChange={(event) => setAddress(event.target.value)} /></label>
                <label>Registration / Tax ID<input required value={registrationId} onChange={(event) => setRegistrationId(event.target.value)} /></label>
              </>
            )}
            <button className="button primary" type="submit" disabled={busy || Boolean(publicDomainError)}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>
          </form>
          {role === 'user' && <button className="button google-button" type="button" disabled={busy} onClick={googleSignIn}>Continue with Google</button>}
          {notice && (
            <div className="verification-prompt" role="status">
              <p>{notice}</p>
              {verificationUser && (
                <div className="verification-actions">
                  <button className="button secondary" type="button" disabled={busy} onClick={resendVerification}>Resend verification email</button>
                  <button className="button primary" type="button" disabled={busy} onClick={checkVerification}>I’ve verified my email</button>
                </div>
              )}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      </section>
    </main>
  )
}
