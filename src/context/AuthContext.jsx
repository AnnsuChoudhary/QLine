import { useCallback, useEffect, useState } from 'react'
import { onIdTokenChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase/config.js'
import { AuthContext } from './AuthContext.js'

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let profileRequest = 0
    let currentUid = null
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      const requestId = ++profileRequest
      const nextUid = user?.uid || null
      if (nextUid !== currentUid) {
        currentUid = nextUid
        setProfile(null)
        setLoading(true)
      }
      setFirebaseUser(user)
      if (!user) {
        setLoading(false)
        return
      }
      try {
        const snapshot = await getDoc(doc(db, 'users', user.uid))
        if (active && requestId === profileRequest) {
          const nextProfile = snapshot.exists() ? snapshot.data() : null
          setProfile(nextProfile && typeof nextProfile === 'object' ? nextProfile : null)
        }
      } catch (error) {
        if (active && requestId === profileRequest) {
          console.error('Failed to load the signed-in user profile.', error)
          setProfile(null)
        }
      } finally {
        if (active && requestId === profileRequest) setLoading(false)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const refreshProfile = useCallback(async (uid = firebaseUser?.uid) => {
    if (!uid) {
      setProfile(null)
      return null
    }
    const snapshot = await getDoc(doc(db, 'users', uid))
    const data = snapshot.exists() ? snapshot.data() : null
    const nextProfile = data && typeof data === 'object' ? data : null
    setProfile(nextProfile)
    return nextProfile
  }, [firebaseUser?.uid])

  return <AuthContext.Provider value={{ firebaseUser, profile, loading, refreshProfile }}>{children}</AuthContext.Provider>
}
