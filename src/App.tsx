import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Reveal from './pages/Reveal'

export default function App() {
  return (
    <div className="min-h-screen min-h-dvh flex flex-col">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/s/:id" element={<Reveal />} />
      </Routes>
    </div>
  )
}
