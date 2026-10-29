import React from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import { tr } from '../../i18n.js';

type RebindForm = {
  accessToken: string;
  platformUserId: string;
  refreshToken: string;
  tokenExpiresAt: string;
};

type AccountRebindModalProps = {
  open: boolean;
  accountLabel: string;
  siteName: string;
  form: RebindForm;
  verifyResult: any;
  verifying: boolean;
  saving: boolean;
  showUserId: boolean;
  showSub2Api: boolean;
  inputStyle: React.CSSProperties;
  onClose: () => void;
  onFormChange: React.Dispatch<React.SetStateAction<RebindForm>>;
  onClearVerification: () => void;
  onVerify: () => void;
  onSubmit: () => void;
};

export default function AccountRebindModal({
  open,
  accountLabel,
  siteName,
  form: rebindForm,
  verifyResult: rebindVerifyResult,
  verifying: rebindVerifying,
  saving: rebindSaving,
  showUserId,
  showSub2Api: isRebindSub2Api,
  inputStyle,
  onClose: closeRebindPanel,
  onFormChange: setRebindForm,
  onClearVerification: clearRebindVerification,
  onVerify: handleVerifyRebindToken,
  onSubmit: handleSubmitRebind,
}: AccountRebindModalProps) {
  return (
    <CenteredModal
              open={open}
              onClose={closeRebindPanel}
              title="重新绑定 Session Token"
              maxWidth={820}
              bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              footer={
                <button onClick={closeRebindPanel} className="btn btn-ghost">
                  {tr('取消')}
                </button>
              }
            >
              {open ? (
                <>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--color-text-muted)',
                      marginBottom: 12,
                    }}
                  >
                    连接: {accountLabel} @{' '}
                    {siteName}。请粘贴新的 Session
                    Token，验证成功后再绑定。
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 220px',
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <textarea
                      placeholder="粘贴新的 Session Token"
                      value={rebindForm.accessToken}
                      onChange={(e) => {
                        setRebindForm((prev) => ({
                          ...prev,
                          accessToken: e.target.value.trim(),
                        }));
                        clearRebindVerification();
                      }}
                      style={{
                        ...inputStyle,
                        fontFamily: 'var(--font-mono)',
                        height: 74,
                        resize: 'none' as const,
                      }}
                    />
                    {showUserId && (
                      <input
                        placeholder="用户 ID（可选）"
                        value={rebindForm.platformUserId}
                        onChange={(e) => {
                          setRebindForm((prev) => ({
                            ...prev,
                            platformUserId: e.target.value.replace(/\D/g, ''),
                          }));
                          clearRebindVerification();
                        }}
                        style={inputStyle}
                      />
                    )}
                  </div>
                  {isRebindSub2Api && (
                    <>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) 220px',
                          gap: 10,
                          marginBottom: 4,
                        }}
                      >
                        <input
                          placeholder="Sub2API refresh_token（可选）"
                          value={rebindForm.refreshToken}
                          onChange={(e) =>
                            setRebindForm((prev) => ({
                              ...prev,
                              refreshToken: e.target.value.trim(),
                            }))
                          }
                          style={{
                            ...inputStyle,
                            fontFamily: 'var(--font-mono)',
                          }}
                        />
                        <input
                          placeholder="token_expires_at（可选）"
                          value={rebindForm.tokenExpiresAt}
                          onChange={(e) =>
                            setRebindForm((prev) => ({
                              ...prev,
                              tokenExpiresAt: e.target.value.replace(/\D/g, ''),
                            }))
                          }
                          style={inputStyle}
                        />
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--color-text-muted)',
                          marginBottom: 10,
                        }}
                      >
                        留空将保持原有 refresh_token
                        不变。配置后可用于托管自动续期。
                      </div>
                    </>
                  )}

                  {rebindVerifyResult &&
                    rebindVerifyResult.success &&
                    rebindVerifyResult.tokenType === 'session' && (
                      <div
                        className="alert alert-success animate-scale-in"
                        style={{ marginBottom: 10 }}
                      >
                        <div className="alert-title">Session Token 有效</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          用户:{' '}
                          {rebindVerifyResult.userInfo?.username || '未知'}
                          {rebindVerifyResult.apiToken
                            ? `，已识别 API Key (${String(rebindVerifyResult.apiToken).slice(0, 8)}...)`
                            : ''}
                        </div>
                      </div>
                    )}
                  {rebindVerifyResult &&
                    (!rebindVerifyResult.success ||
                      rebindVerifyResult.tokenType !== 'session') && (
                      <div
                        className="alert alert-error animate-scale-in"
                        style={{ marginBottom: 10 }}
                      >
                        <div className="alert-title">
                          {rebindVerifyResult.message ||
                            'Token 无效或类型不正确'}
                        </div>
                      </div>
                    )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleVerifyRebindToken}
                      disabled={
                        rebindVerifying || !rebindForm.accessToken.trim()
                      }
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)' }}
                    >
                      {rebindVerifying ? (
                        <>
                          <span className="spinner spinner-sm" />
                          {tr('验证中...')}
                        </>
                      ) : (
                        '验证 Token'
                      )}
                    </button>
                    <button
                      onClick={handleSubmitRebind}
                      disabled={
                        rebindSaving ||
                        !(
                          rebindVerifyResult?.success &&
                          rebindVerifyResult?.tokenType === 'session'
                        )
                      }
                      className="btn btn-primary"
                    >
                      {rebindSaving ? (
                        <>
                          <span
                            className="spinner spinner-sm"
                            style={{
                              borderTopColor: 'white',
                              borderColor: 'rgba(255,255,255,0.3)',
                            }}
                          />
                          绑定中...
                        </>
                      ) : (
                        '确认重新绑定'
                      )}
                    </button>
                  </div>
                </>
              ) : null}
    </CenteredModal>
  );
}
