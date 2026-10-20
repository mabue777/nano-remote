import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { AppState } from 'react-native';

import { areLiveActivitiesEnabled, isLiveActivityRunning, startLiveActivity, stopLiveActivity, updateLiveActivity } from '@/modules/activity-controller';
import type { UIMessage } from '@/store/sessions';

import { useChat } from './use-chat';

export function useLiveActivity() {
  const [running, setRunning] = useState(false);
  const lastStateRef = useRef(AppState.currentState);
  const { messages } = useChat();

  const start = async (question: string, model: string) => {
    if (Platform.OS !== 'ios') return;

    if (!areLiveActivitiesEnabled) return;

    setRunning(true);
    await startLiveActivity({ question, model });
  };

  const stop = async () => {
    if (Platform.OS !== 'ios') return;

    if (!isLiveActivityRunning()) return;

    setRunning(false);
    await stopLiveActivity();
  };

  const update = async (data: UIMessage) => {
    if (Platform.OS !== 'ios') return;

    if (!isLiveActivityRunning()) return;

    const { isPending = true, isThinking = false, isStreaming = false, isAborted = false } = data;
    await updateLiveActivity({
      status: { isThinking, isPending, isStreaming, isAborted }
    });
  };

  useEffect(() => {
    if (messages.length > 1) {
      update(messages.at(-1)!);
      if (lastStateRef.current === 'active' && messages.at(-1)?.isAborted) {
        stop();
      }
    }

    const sub = AppState.addEventListener('change', next => {
      if (lastStateRef.current === 'background' && next === 'active' && messages.length > 1) {
        const { isStreaming, isPending, isThinking, isAborted } = messages.at(-1)!;
        if (!isStreaming && !isPending && !isThinking && !isAborted) {
          stop();
        }
      }
      lastStateRef.current = next;
    });

    return () => sub.remove();
  }, [messages]);

  return { running, start, stop, update };
}
