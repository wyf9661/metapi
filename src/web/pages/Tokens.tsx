import { Navigate, useLocation } from 'react-router-dom';

export { TokensPanel } from './tokens/TokensPanel.js';

export default function Tokens() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('segment', 'tokens');
  const nextSearch = params.toString();
  return <Navigate to={`/accounts${nextSearch ? `?${nextSearch}` : ''}`} replace />;
}
