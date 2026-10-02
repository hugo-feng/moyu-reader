import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { installSafeAreaDetection } from './ui/safeArea'

// 尽早探测设备安全区（状态栏 / 手势条），把结果写进 CSS 变量。
// 放在 render 之前：否则首屏会用 0 的兜底值先画一遍，出现一次可见的跳动。
installSafeAreaDetection()

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
