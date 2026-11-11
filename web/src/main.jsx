import { createRoot } from 'react-dom/client';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import App from './App.jsx';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

ModuleRegistry.registerModules([AllCommunityModule]);
createRoot(document.getElementById('root')).render(<App />);
