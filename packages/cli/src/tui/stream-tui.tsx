#!/usr/bin/env tsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { render, Text, Box, Newline, useInput, useApp } from 'ink';
import InkTable from 'ink-table';

/**
 * ink-table v3 ships a default export at runtime but does not declare it in
 * its type definitions, so the import cannot be used as a JSX component
 * without a cast.
 */
const Table = InkTable as unknown as React.FC<{
  data: Array<Record<string, string | number | boolean | null | undefined>>;
  padding?: number;
}>;
import { PaymentDTO } from '../lib/types.js';

export interface StreamTuiProps {
  dispatch?: (action: StreamTuiAction) => void;
  onPayment?: (payment: PaymentDTO) => void;
  onQuit?: () => void;
  initialPaused?: boolean;
}

export interface StreamTuiState {
  payments: PaymentDTO[];
  isPaused: boolean;
  filter: string;
  totalReceived: number;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  lastUpdate: string;
}

export type StreamTuiAction =
  | { type: 'ADD_PAYMENT'; payload: PaymentDTO }
  | { type: 'TOGGLE_PAUSE' }
  | { type: 'SET_FILTER'; payload: string }
  | { type: 'CLEAR' }
  | { type: 'SET_CONNECTION_STATUS'; payload: 'connected' | 'disconnected' | 'connecting' }
  | { type: 'QUIT' };

export function streamTuiReducer(
  state: StreamTuiState,
  action: StreamTuiAction,
): StreamTuiState {
  switch (action.type) {
    case 'ADD_PAYMENT':
      return {
        ...state,
        payments: [action.payload, ...state.payments].slice(0, 50),
        totalReceived: state.totalReceived + 1,
        lastUpdate: new Date().toISOString(),
      };
    case 'TOGGLE_PAUSE':
      return {
        ...state,
        isPaused: !state.isPaused,
        lastUpdate: new Date().toISOString(),
      };
    case 'SET_FILTER':
      return {
        ...state,
        filter: action.payload,
        lastUpdate: new Date().toISOString(),
      };
    case 'CLEAR':
      return {
        ...state,
        payments: [],
        lastUpdate: new Date().toISOString(),
      };
    case 'SET_CONNECTION_STATUS':
      return {
        ...state,
        connectionStatus: action.payload,
        lastUpdate: new Date().toISOString(),
      };
    case 'QUIT':
      return state;
    default:
      return state;
  }
}

const StreamTui: React.FC<StreamTuiProps> = ({
  onPayment,
  onQuit,
  initialPaused = false,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<StreamTuiState>({
    payments: [],
    isPaused: initialPaused,
    filter: '',
    totalReceived: 0,
    connectionStatus: 'connecting',
    lastUpdate: new Date().toISOString(),
  });

  const dispatch = useCallback((action: StreamTuiAction) => {
    setState((prev) => streamTuiReducer(prev, action));
  }, []);

  // Handle keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // Ctrl+C to quit
      onQuit?.();
      exit();
    } else if (input === 'q') {
      // q to quit
      onQuit?.();
      exit();
    } else if (input === 'c') {
      // c to clear
      dispatch({ type: 'CLEAR' });
    } else if (input === 'p') {
      // p to pause/resume
      dispatch({ type: 'TOGGLE_PAUSE' });
    } else if (input === '/') {
      // / to set filter (simplified - just clears filter for now)
      dispatch({ type: 'SET_FILTER', payload: '' });
    }
  });

  // Filter payments based on filter string
  const filteredPayments = useMemo(() => {
    if (!state.filter) return state.payments;
    const lowerFilter = state.filter.toLowerCase();
    return state.payments.filter(
      (p) =>
        p.fromAddress.toLowerCase().includes(lowerFilter) ||
        p.asset.toLowerCase().includes(lowerFilter) ||
        p.memo?.toLowerCase().includes(lowerFilter),
    );
  }, [state.payments, state.filter]);

  // Calculate transaction volume metrics
  const volumeMetrics = useMemo(() => {
    const totalAmount = state.payments.reduce((sum, p) => {
      const amount = parseFloat(String(p.amount));
      return isNaN(amount) ? sum : sum + amount;
    }, 0);

    const uniqueSenders = new Set(state.payments.map((p) => p.fromAddress)).size;
    const assets = new Set(state.payments.map((p) => p.asset)).size;

    return { totalAmount, uniqueSenders, assets };
  }, [state.payments]);

  // Connection status color
  const statusColor = {
    connected: 'green',
    disconnected: 'red',
    connecting: 'yellow',
  } as const;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="blue">
          🌊 Stellar Payment Stream - TUI Dashboard
        </Text>
      </Box>

      {/* Status Bar */}
      <Box marginBottom={1}>
        <Text color={statusColor[state.connectionStatus]}>
          ● {state.connectionStatus.toUpperCase()}
        </Text>
        <Text dimColor> │ </Text>
        <Text dimColor>Last Update: {new Date(state.lastUpdate).toLocaleTimeString()}</Text>
        <Text dimColor> │ </Text>
        <Text color={state.isPaused ? 'yellow' : 'green'}>
          {state.isPaused ? '⏸ PAUSED' : '▶ LIVE'}
        </Text>
      </Box>

      {/* Summary Stats */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Summary Statistics</Text>
        <Box>
          <Text>Total Payments: </Text>
          <Text color="green">{state.totalReceived}</Text>
          <Text dimColor> │ </Text>
          <Text>Filtered: </Text>
          <Text color="yellow">{filteredPayments.length}</Text>
          <Text dimColor> │ </Text>
          <Text>Volume: </Text>
          <Text color="magenta">{volumeMetrics.totalAmount.toFixed(2)}</Text>
          <Text dimColor> │ </Text>
          <Text>Unique Senders: </Text>
          <Text color="blue">{volumeMetrics.uniqueSenders}</Text>
          <Text dimColor> │ </Text>
          <Text>Assets: </Text>
          <Text color="blue">{volumeMetrics.assets}</Text>
        </Box>
      </Box>

      {/* Filter */}
      {state.filter && (
        <Box marginBottom={1}>
          <Text dimColor>Filter: </Text>
          <Text color="yellow">{state.filter}</Text>
        </Box>
      )}

      {/* Payment Feed */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">Recent Payments (Last 50)</Text>
        {filteredPayments.length > 0 ? (
          <Table
            data={filteredPayments.map((p) => ({
              Time: new Date(p.receivedAt).toLocaleTimeString(),
              Amount: `${p.amount} ${p.asset}`,
              From: `${p.fromAddress.slice(0, 8)}...${p.fromAddress.slice(-4)}`,
              Memo: p.memo || '-',
            }))}
            padding={1}
          />
        ) : (
          <Text dimColor>No payments received yet...</Text>
        )}
      </Box>

      {/* Keyboard Shortcuts */}
      <Box>
        <Text dimColor color="gray">
          Shortcuts: [q] Quit | [c] Clear | [p] Pause/Resume | [/] Filter | [Ctrl+C] Force Quit
        </Text>
      </Box>
    </Box>
  );
};

export default StreamTui;

if (require.main === module) {
  render(<StreamTui />);
}
