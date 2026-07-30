import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';

const Accounts = lazy(() => import('./Accounts.js'));

type SiteDetail = {
  id: number;
  name: string;
  url: string;
  platform?: string;
  status?: string;
};

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [site, setSite] = useState<SiteDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    loadSite();
  }, [id]);

  const loadSite = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.getSite(Number(id));
      setSite(data);
    } catch {
      toast.error('加载站点失败');
      navigate('/sites');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ textAlign: 'center', padding: '40px' }}>加载中...</div>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="page-container">
        <div style={{ textAlign: 'center', padding: '40px' }}>站点不存在</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/sites')}
            className="btn btn-ghost"
            style={{ padding: '6px 12px' }}
          >
            ← 返回
          </button>
          <h2 className="page-title" style={{ margin: 0 }}>
            {site.name}
          </h2>
          {site.platform && (
            <span className="badge badge-info" style={{ fontSize: 11 }}>
              {site.platform}
            </span>
          )}
          <span
            className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`}
            style={{ fontSize: 11 }}
          >
            {site.status === 'disabled' ? '禁用' : '启用'}
          </span>
        </div>
      </div>

      <Suspense fallback={<div style={{ textAlign: 'center', padding: '40px' }}>加载中...</div>}>
        <Accounts siteId={site.id} />
      </Suspense>
    </div>
  );
}
