import * as Linking from 'expo-linking';
import { Github, History, Trash2 } from 'lucide-react-native';
import { useState } from 'react';

import { useSessions } from '@/hooks/use-sessions';
import { useSettings } from '@/hooks/use-settings';
import { PROJECT_GITHUB_URL } from '@/lib/constants';

import { SettingSection } from '../setting-section';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Icon } from '../ui/icon';
import { Text } from '../ui/text';

export function Actions() {
  const [, setSettings] = useSettings();
  const { clearSessions } = useSessions();
  const [open, setOpen] = useState(false);

  const handleViewOnGithub = async () => {
    const supported = await Linking.canOpenURL(PROJECT_GITHUB_URL);

    if (supported) {
      await Linking.openURL(PROJECT_GITHUB_URL);
    }
  };

  const handleClearHistoryAPIEndpoints = () => {
    setSettings(settings => {
      settings.endpoints = [];
    });
  };

  return (
    <SettingSection>
      <Button variant="outline" className="dark:bg-black" onPress={handleViewOnGithub}>
        <Text>View on Github</Text>
        <Icon as={Github} size={16} />
      </Button>
      <Button variant="outline" className="dark:bg-black" onPress={handleClearHistoryAPIEndpoints}>
        <Text>Clear API Endpoint Records</Text>
        <Icon as={History} size={16} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive">
            <Text>Delete All Sessions</Text>
            <Icon as={Trash2} size={16} className="text-white" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you absolutely sure?</DialogTitle>
            <DialogDescription>This action cannot be undone. This will permanently delete all your conversations.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">
                <Text>Cancel</Text>
              </Button>
            </DialogClose>
            <Button
              onPress={() => {
                clearSessions();
                setOpen(false);
              }}>
              <Text>Delete</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
}
