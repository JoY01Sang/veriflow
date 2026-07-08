import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { REVIEWER_ROLES, profileRoleLabel } from '../lib/roleLabels'

export function Sidebar() {
  const { profile, signOut } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const location = useLocation()

  const isActive = (path: string) => location.pathname === path

  const navItems = [
    { path: '/dashboard', label: 'Dashboard', icon: '📊' },
    ...(profile?.role === 'student'
      ? [{ path: '/documents', label: 'My Documents', icon: '📄' }]
      : []),
    ...(profile?.role && REVIEWER_ROLES.includes(profile.role)
      ? [{ path: '/approvals', label: 'My Approvals', icon: '✓' }]
      : []),
    ...(profile?.role === 'student' ? [{ path: '/documents/submit', label: 'Submit Document', icon: '📤' }] : []),
    ...(profile?.role === 'registrar' ? [{ path: '/reports', label: 'Reports', icon: '📈' }] : []),
    { path: '/settings', label: 'Settings', icon: '⚙️' },
  ]

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 z-50 p-2 rounded-lg bg-orange-600 text-white md:hidden"
      >
        {isOpen ? '✕' : '☰'}
      </button>

      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-gradient-to-b from-orange-600 to-orange-700 text-white shadow-lg transition-transform duration-300 z-40 md:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="p-6 border-b border-orange-500">
            <h1 className="text-2xl font-bold">Veriflow</h1>
            <p className="text-sm text-orange-100 mt-1">Secure E-Approvals</p>
          </div>

          {/* Navigation */}
          <nav className="flex-1 p-4 space-y-2">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setIsOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  isActive(item.path)
                    ? 'bg-orange-500 text-white'
                    : 'text-orange-100 hover:bg-orange-500/50'
                }`}
              >
                <span className="text-lg">{item.icon}</span>
                <span className="font-medium">{item.label}</span>
              </Link>
            ))}
          </nav>

          {/* User profile & logout */}
          <div className="p-4 border-t border-orange-500">
            <div className="bg-orange-500/30 rounded-lg p-3 mb-3">
              <p className="text-xs text-orange-100">Logged in as</p>
              <p className="font-semibold truncate">{profile?.full_name}</p>
              <p className="text-xs text-orange-100">{profileRoleLabel(profile)}</p>
            </div>
            <button
              onClick={() => signOut().then(() => (window.location.href = '/login'))}
              className="w-full px-4 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded-lg font-medium transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
