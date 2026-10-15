import { Navigate, Route, Routes } from 'react-router'
import './assets/App.css'
import RequireAuth from './components/RequireAuth'
import Shell from './components/Shell'
import { AuthProvider } from './lib/AuthProvider'
import CabinetPage from './pages/CabinetPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<Navigate to="/cabinet" replace />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/cabinet"
            element={
              <RequireAuth>
                <CabinetPage />
              </RequireAuth>
            }
          />
          {/* Nothing else exists yet, and a redirect beats a dead end. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

export default App
