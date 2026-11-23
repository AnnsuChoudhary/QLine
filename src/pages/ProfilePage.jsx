import { useState } from 'react'
import { reload, sendEmailVerification, updateProfile } from 'firebase/auth'
import { doc, updateDoc } from 'firebase/firestore'
import { auth, db } from '../firebase/config.js'
import { useAuth } from '../context/useAuth.js'
import AppHeader from '../components/AppHeader.jsx'

export default function ProfilePage() {
  const { firebaseUser, profile, refreshProfile } = useAuth()
  const [nameDraft, setNameDraft] = useState({ uid: '', value: '' })
  const [detailsDraft, setDetailsDraft] = useState({ uid: '', admissionId: '', employeeId: '', department: '' })
  const [verificationState, setVerificationState] = useState({ uid: '', verified: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const name = nameDraft.uid === firebaseUser.uid
    ? nameDraft.value
    : profile?.name || firebaseUser.displayName || ''
  const details = detailsDraft.uid === firebaseUser.uid
    ? detailsDraft
    : {
      admissionId: profile?.admissionId || '',
      employeeId: profile?.employeeId || '',
      department: profile?.department || '',
    }
  const emailVerified = verificationState.uid === firebaseUser.uid
    ? verificationState.verified
    : Boolean(firebaseUser.emailVerified)

  const saveProfile = async (event) => {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName) {
      setError('Enter your name before saving.')
      return
    }
    if (nextName.length > 100) {
      setError('Your name must be 100 characters or fewer.')
      return
    }
    const nextDetails = {
      admissionId: details.admissionId.trim(),
      employeeId: details.employeeId.trim(),
      department: details.department.trim(),
    }
    if (Object.values(nextDetails).some((value) => value.length > 100)) {
      setError('Admission ID, employee ID, and department must be 100 characters or fewer.')
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      await updateDoc(doc(db, 'users', firebaseUser.uid), { name: nextName, ...nextDetails })
      await updateProfile(firebaseUser, { displayName: nextName })
      await refreshProfile(firebaseUser.uid)
      setNotice('Your profile has been saved.')
    } catch (requestError) {
      console.error('Could not save the user profile:', requestError)
      setError(`Could not save your profile: ${requestError.message}`)
      await refreshProfile(firebaseUser.uid).catch((refreshError) => {
        console.error('Could not refresh the user profile after a save error:', refreshError)
      })
    } finally {
      setBusy(false)
    }
  }

  const resendVerification = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await sendEmailVerification(auth.currentUser)
      setNotice(`A verification link was sent to ${firebaseUser.email}.`)
    } catch (requestError) {
      console.error('Could not send an email verification link:', requestError)
      setError(`Could not send a verification link: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const checkVerification = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await reload(auth.currentUser)
      await auth.currentUser.getIdToken(true)
      setVerificationState({ uid: firebaseUser.uid, verified: Boolean(auth.currentUser.emailVerified) })
      setNotice(auth.currentUser.emailVerified
        ? 'Your email is verified. You can now join queues and book appointments.'
        : 'Your email is not verified yet. Open the link we sent, then check again.')
    } catch (requestError) {
      console.error('Could not refresh email verification status:', requestError)
      setError(`Could not check verification status: ${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <AppHeader />
      <section className="page-shell profile-page">
        <div className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>Your profile</h1></div></div>
        <section className="panel profile-card">
          <form className="profile-form" onSubmit={saveProfile}>
            <label>
              Name
              <input value={name} onChange={(event) => setNameDraft({ uid: firebaseUser.uid, value: event.target.value })} maxLength={100} required />
            </label>
            <p className="muted">Organizations may require these details before you can book. Only fill in what applies to you.</p>
            <label>
              Admission ID
              <input value={details.admissionId} onChange={(event) => setDetailsDraft({ uid: firebaseUser.uid, ...details, admissionId: event.target.value })} maxLength={100} autoComplete="off" />
            </label>
            <label>
              Employee ID
              <input value={details.employeeId} onChange={(event) => setDetailsDraft({ uid: firebaseUser.uid, ...details, employeeId: event.target.value })} maxLength={100} autoComplete="off" />
            </label>
            <label>
              Department
              <input value={details.department} onChange={(event) => setDetailsDraft({ uid: firebaseUser.uid, ...details, department: event.target.value })} maxLength={100} autoComplete="organization" />
            </label>
            <label>
              Email address
              <input value={firebaseUser.email || ''} readOnly aria-describedby="profile-email-help" />
              <small id="profile-email-help">Email addresses are managed by your sign-in provider.</small>
            </label>
            <div className="profile-verification">
              <span>Email verification</span>
              <strong className={`status-pill ${emailVerified ? 'serving' : 'warning'}`}>
                {emailVerified ? 'Verified' : 'Not verified'}
              </strong>
              {!emailVerified && <>
                <button className="button secondary" type="button" onClick={resendVerification} disabled={busy}>Resend verification email</button>
                <button className="button secondary" type="button" onClick={checkVerification} disabled={busy}>I’ve verified</button>
              </>}
            </div>
            <button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </form>
          {notice && <p className="form-success" role="status">{notice}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>
      </section>
    </main>
  )
}
