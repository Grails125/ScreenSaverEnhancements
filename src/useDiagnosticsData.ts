import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from './clipboard';
import { Diagnostics, parseDiagnostics } from './diagnostics';
import { PluginServerApi } from './deckyApi';

export type EventChannelDiagnostics = Pick<
  Diagnostics,
  'pushListenerActive' | 'pushReconnectCount' | 'lastFullSyncAt' | 'lastFullSyncSuccessful'
>;

type Translate = (key: any) => string;

export const useDiagnosticsData = (
  serverApi: PluginServerApi,
  getEventChannelDiagnostics: () => EventChannelDiagnostics,
  translate: Translate,
) => {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState<boolean>(false);
  const [diagnosticsExportStatus, setDiagnosticsExportStatus] = useState<string>('');
  const diagnosticsExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (diagnosticsExportTimeoutRef.current !== null) {
      clearTimeout(diagnosticsExportTimeoutRef.current);
      diagnosticsExportTimeoutRef.current = null;
    }
  }, []);

  const refreshDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const result = await serverApi.getDiagnostics();
      const parsed = parseDiagnostics(result);
      setDiagnostics(parsed ? { ...parsed, ...getEventChannelDiagnostics() } : null);
    } catch (error) {
      console.warn('[ScreenSaverEnhancements] Could not load diagnostics', error);
      setDiagnostics(null);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const exportDiagnostics = async () => {
    if (!diagnostics) return;
    const copied = await copyTextToClipboard(JSON.stringify(diagnostics, null, 2));
    if (copied) {
      setDiagnosticsExportStatus(translate('Diagnostic Report Copied'));
    } else {
      console.warn('[ScreenSaverEnhancements] No clipboard method succeeded');
      setDiagnosticsExportStatus(translate('Diagnostic Export Failed'));
    }
    if (diagnosticsExportTimeoutRef.current !== null) {
      clearTimeout(diagnosticsExportTimeoutRef.current);
    }
    diagnosticsExportTimeoutRef.current = setTimeout(() => {
      diagnosticsExportTimeoutRef.current = null;
      setDiagnosticsExportStatus('');
    }, 2000);
  };

  return {
    diagnostics,
    diagnosticsLoading,
    diagnosticsExportStatus,
    refreshDiagnostics,
    exportDiagnostics,
  };
};
