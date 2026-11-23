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
  const [pendingOrganization, setPendingOrganization] = useState(null)
  const [error, setError] = useState(location.state?.verificationRequired ? 'Verify your email before opening the organization dashboard.' : '')
  const [notice, setNotice] = useState('')
  const [verificationUser, setVerificationUser] = useState(
    location.state?.verificationRequired ? firebaseUser : null,
  )
  const [busy, setBusy] = useState(false)
  const routeVerificationUser = location.state?.verificationRequired ? firebaseUser : null
  const activeVerificationUser = verificationUser || routeVerificationUser
  const verificationNotice = notice || (routeVerificationUser
    ? `Verify your email (check inbox/spam) and click "I've verified" to continue. Use Resend verification email if needed.`
    : '')

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
      ? `Verify your email (check inbox/spam) and click "I've verified" to continue. We sent a link to ${user.email}.`
      : `Verify your email (check inbox/spam) and click "I've verified" to continue. Use Resend verification email if needed.`)
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
        const existingProfile = await getDoc(doc(db, 'users', credential.user.uid))
        if (!existingProfile.exists() && (role === 'organization' || location.state?.verificationRequired)) {
          showVerificationPrompt(credential.user)
          return
        }
        const profile = existingProfile.exists()
          ? await refreshProfile(credential.user.uid)
          : await ensureUserProfile(credential)
        if (profile?.role === 'org_admin') {
          if (!credential.user.emailVerified) {
            showVerificationPrompt(credential.user)
            return
          }
          navigate('/dashboard')
          return
        }
        if (!credential.user.emailVerified) {
          showVerificationPrompt(credential.user)
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
        setPendingOrganization({
          name: orgName.trim(),
          officialEmail: credential.user.email,
          category,
          address: address.trim(),
          registrationId: registrationId.trim(),
        })
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
        showVerificationPrompt(credential.user)
        await sendEmailVerification(credential.user)
        showVerificationPrompt(credential.user, true)
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
    if (!activeVerificationUser) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await sendEmailVerification(activeVerificationUser)
      setNotice(`Verify your email (check inbox/spam) and click "I've verified" to continue. A new link was sent to ${activeVerificationUser.email}.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const checkVerification = async () => {
    if (!activeVerificationUser) return
    setBusy(true)
    setError('')
    try {
      await reload(activeVerificationUser)
      if (!activeVerificationUser.emailVerified) {
        setError('Your email is not verified yet. Check your inbox and spam folder, open the verification link, then try again.')
        return
      }
      await activeVerificationUser.getIdToken(true)
      if (pendingOrganization) {
        const domain = pendingOrganization.officialEmail.split('@')[1]
        const orgSlug = `${slugify(pendingOrganization.name) || 'organization'}-${activeVerificationUser.uid}`
        await createOrganizationWithUniqueJoinCode(activeVerificationUser, {
          ...pendingOrganization,
          slug: orgSlug,
          adminUid: activeVerificationUser.uid,
          domain,
          status: 'pending',
          verificationStatus: 'pending',
          services: [],
          hours: {},
        })
        await refreshProfile(activeVerificationUser.uid)
        setPendingOrganization(null)
        setNotice('')
        navigate('/dashboard')
        return
      }
      const profile = await refreshProfile(activeVerificationUser.uid)
      if (profile?.role === 'org_admin') {
        navigate('/dashboard')
        return
      }
      if (profile?.role === 'user') {
        navigate(getCustomerDestination(location, searchParams))
        return
      }
      setError('Your email is verified, but account setup is incomplete. Return to registration to finish setup.')
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
          {!pendingOrganization && <div className="role-toggle" role="tablist" aria-label="Account role">
            <button type="button" className={role === 'user' ? 'active' : ''} onClick={() => { setRole('user'); setError('') }}>Customer / User</button>
            <button type="button" className={role === 'organization' ? 'active' : ''} onClick={() => { setRole('organization'); setError('') }}>Organization Admin</button>
          </div>}
          {!pendingOrganization && <form className="auth-form" onSubmit={submit}>
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
          </form>}
          {role === 'user' && <button className="button google-button" type="button" disabled={busy} onClick={googleSignIn}>Continue with Google</button>}
          {verificationNotice && (
            <div className="verification-prompt" role="status">
              <p>{verificationNotice}</p>
              {activeVerificationUser && (
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
