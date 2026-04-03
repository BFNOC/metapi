import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ModernSelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

type ModernSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: ModernSelectOption[];
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  menuMaxHeight?: number;
  className?: string;
  size?: 'md' | 'sm';
};

export default function ModernSelect({
  value,
  onChange,
  options,
  placeholder = 'Select',
  searchable = false,
  searchPlaceholder = '搜索选项',
  disabled = false,
  emptyLabel = 'No options',
  menuMaxHeight = 280,
  className = '',
  size = 'md',
}: ModernSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selected = useMemo(
    () => options.find((item) => item.value === value),
    [options, value],
  );
  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((item) => {
      const haystacks = [item.label, item.description || ''];
      return haystacks.some((part) => part.toLowerCase().includes(query));
    });
  }, [options, search, searchable]);

  // Calculate panel position based on trigger element
  const updatePanelPosition = useCallback(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 8,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  // Update position when open changes or on scroll/resize
  useLayoutEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    updatePanelPosition();

    const handleScrollOrResize = () => updatePanelPosition();
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);
  useEffect(() => {
    if (!open || !searchable) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [open, searchable]);

  const renderOptionIcon = (item: ModernSelectOption) => {
    if (item.iconNode) {
      return item.iconNode;
    }
    if (item.iconUrl) {
      return <img className="modern-select-option-icon" src={item.iconUrl} alt="" loading="lazy" />;
    }
    if (item.iconText) {
      return <span className="modern-select-option-icon-text">{item.iconText}</span>;
    }
    return null;
  };

  const canRenderPortal = typeof document !== 'undefined';
  const panelContent = open && panelPos && canRenderPortal ? createPortal(
    <div
      ref={panelRef}
      className="modern-select-panel is-portal-open"
      style={{
        position: 'fixed',
        top: panelPos.top,
        left: panelPos.left,
        width: panelPos.width,
        maxHeight: menuMaxHeight,
        zIndex: 9999,
      }}
    >
      {searchable ? (
        <div style={{ padding: 8, borderBottom: '1px solid var(--color-border)' }}>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className="input"
            style={{ width: '100%', minHeight: size === 'sm' ? 34 : 38 }}
          />
        </div>
      ) : null}
      {filteredOptions.length === 0 ? (
        <div className="modern-select-empty">{emptyLabel}</div>
      ) : (
        filteredOptions.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              className={`modern-select-option ${active ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim()}
              onClick={() => {
                if (item.disabled) return;
                onChange(item.value);
                setOpen(false);
              }}
              disabled={item.disabled}
            >
              <div className="modern-select-option-main">
                {renderOptionIcon(item)}
                <div style={{ minWidth: 0 }}>
                  <div className="modern-select-option-label">{item.label}</div>
                  {item.description && (
                    <div className="modern-select-option-desc">{item.description}</div>
                  )}
                </div>
              </div>
              {active && (
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          );
        })
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <div
      ref={rootRef}
      className={`modern-select ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${size === 'sm' ? 'is-sm' : ''} ${className}`.trim()}
    >
      <button
        type="button"
        className="modern-select-trigger"
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        disabled={disabled}
      >
        <span className={`modern-select-value ${selected ? '' : 'is-placeholder'}`.trim()}>
          {selected ? (
            <span className="modern-select-value-content">
              {renderOptionIcon(selected)}
              <span>{selected.label}</span>
            </span>
          ) : (
            placeholder
          )}
        </span>
        <svg
          className="modern-select-chevron"
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {panelContent}
    </div>
  );
}
