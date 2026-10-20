import { fetch } from 'expo/fetch';
import { useState } from 'react';

import { useSessions } from '@/hooks/use-sessions';
import { useSettings } from '@/hooks/use-settings';
import { AIProviderEnum } from '@/lib/ai';
import type { Model } from '@/store/settings';

export function useModels() {
  const [{ provider = AIProviderEnum.OLLAMA, host: baseURL, apiKey }] = useSettings();
  const [models, setModels] = useState<Model[]>([]);
  const { currentSession, setSessions } = useSessions();
  const { model: currentModel } = currentSession || {};

  const discoverModels = async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    switch (provider) {
      case AIProviderEnum.ANTHROPIC: {
        return [
          'claude-3-haiku-20240307',
          'claude-haiku-4-5-20251001',
          'claude-haiku-4-5',
          'claude-opus-4-0',
          'claude-opus-4-20250514',
          'claude-opus-4-1-20250805',
          'claude-opus-4-1',
          'claude-opus-4-5',
          'claude-opus-4-5-20251101',
          'claude-sonnet-4-0',
          'claude-sonnet-4-20250514',
          'claude-sonnet-4-5-20250929',
          'claude-sonnet-4-5',
          'claude-sonnet-4-6',
          'claude-opus-4-6'
        ].map(name => ({ name, canThink: true }));
      }
      case AIProviderEnum.OPENAI: {
        const result = await fetch(`${baseURL ?? 'https://api.openai.com'}/v1/models`, { method: 'GET', headers });

        if (result.ok) {
          const { data } = (await result.json()) as { data: { id: string }[] };
          return data.map(({ id }) => ({ name: id, canThink: true }));
        }

        throw Error(`${result.status} ${result.statusText}`);
      }
      case AIProviderEnum.OLLAMA: {
        if (!baseURL) throw Error('Base URL is missing');
        const result = await fetch(`${baseURL}/api/tags`, { method: 'GET', headers });

        if (result.ok) {
          const { models } = (await result.json()) as { models: { name: string; details: { family: string } }[] };
          return models.map(({ name, details }) => ({ name, canThink: ['qwen2', 'qwen3', 'qwen3moe', 'deepseek2', 'gptoss'].includes(details.family) }));
        }

        throw Error(`${result.status} ${result.statusText}`);
      }
      case AIProviderEnum.GOOGLE: {
        const result = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          method: 'GET',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          }
        });

        if (result.ok) {
          const { models } = (await result.json()) as { models: { name: string }[] };
          return models.map(({ name }) => ({ name: name.split('models/')[1], canThink: true }));
        }

        throw Error(`${result.status} ${result.statusText}`);
      }
      case AIProviderEnum.CUSTOM:
      case AIProviderEnum.OPENCLAW: {
        if (!baseURL) throw Error('Base URL is missing');
        const result = await fetch(`${baseURL}/models`, { method: 'GET', headers });

        if (result.ok) {
          const { data } = (await result.json()) as { data: { id: string }[] };
          return data.map(({ id }) => ({ name: id, canThink: true }));
        }

        throw Error(`${result.status} ${result.statusText}`);
      }
      default:
        return [];
    }
  };

  const fetchModels = async () => {
    const models = await discoverModels();

    setModels(models);
  };

  const setCurrentModel = (model?: Model) => {
    setSessions(sessions => {
      const { current, data } = sessions;
      data[current].model = model;
    });
  };

  return {
    models,
    currentModel,
    discoverModels,
    fetchModels,
    setCurrentModel
  };
}
