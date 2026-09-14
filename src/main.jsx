import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { DataProvider } from './DataContext.jsx'
import { SimResultsProvider } from './simResultsContext.jsx'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <DataProvider>
        <SimResultsProvider>
          <App />
        </SimResultsProvider>
      </DataProvider>
    </BrowserRouter>
  </React.StrictMode>
)
