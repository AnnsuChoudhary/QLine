import { useCallback, useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase/config.js'
import { AuthContext } from './AuthContext.js'

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => onAuthStateChanged(auth, async (user) => {
    setFirebaseUser(user)
    if (!user) {
      setProfile(null)
      setLoading(false)
      return
    }
    try {
      const snapshot = await getDoc(doc(db, 'users', user.uid))
      setProfile(snapshot.exists() ? snapshot.data() : null)
    } catch (error) {
      console.error('Failed to load the signed-in user profile.', error)
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }), [])

  const refreshProfile = useCallback(async (uid = firebaseUser?.uid) => {
    if (!uid) {
      setProfile(null)
      return null
    }
    const snapshot = await getDoc(doc(db, 'users', uid))
    const nextProfile = snapshot.exists() ? snapshot.data() : null
    setProfile(nextProfile)
    return nextProfile
  }, [firebaseUser?.uid])

  const value = useMemo(() => ({ firebaseUser, profile, loading, refreshProfile }), [firebaseUser, profile, loading, refreshProfile])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
