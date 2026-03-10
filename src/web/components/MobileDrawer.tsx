import React from 'react';

type MobileDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  if (!open) return null;

  return (
    <div className="mobile-drawer-root">
      <button
        type="button"
        className="mobile-drawer-backdrop"
        onClick={onClose}
        aria-label="Close navigation"
      />
      <div className="mobile-drawer-panel" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export { MobileDrawer };
export default MobileDrawer;
