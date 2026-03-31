import CenteredModal from './CenteredModal.js';

type NextStepChoice = 'session' | 'apikey' | 'later';

type Props = {
  siteName: string;
  platform?: string | null;
  onChoice: (choice: NextStepChoice) => void;
  onClose: () => void;
};

export default function SiteCreatedModal({ siteName, platform, onChoice, onClose }: Props) {
  const handleClose = () => {
    onChoice('later');
  };

  return (
    <CenteredModal
      open
      onClose={handleClose}
      closeOnBackdrop
      maxWidth={480}
      title={
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          站点创建成功
        </div>
      }
      footer={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => onChoice('session')}
          >
            添加账号（用户名密码登录）
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%', border: '1px solid var(--color-border)' }}
            onClick={() => onChoice('apikey')}
          >
            添加 API Key
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%' }}
            onClick={() => onChoice('later')}
          >
            稍后配置
          </button>
        </div>
      }
    >
      <p style={{ color: 'var(--color-text-muted)', fontSize: 13, margin: 0 }}>
        站点 <strong>"{siteName}"</strong> 已添加成功。接下来您想做什么？
      </p>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 12, margin: '8px 0 0' }}>
        提示：您可以随时在"站点管理"页面配置账号信息
      </p>
    </CenteredModal>
  );
}