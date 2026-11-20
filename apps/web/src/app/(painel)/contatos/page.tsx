'use client';

import { useCallback, useEffect, useState } from 'react';
import { BlacklistTab } from '@/components/contacts/BlacklistTab';
import { ContactsTab } from '@/components/contacts/ContactsTab';
import { ListsTab } from '@/components/contacts/ListsTab';
import { api } from '@/lib/api';
import type { ContactList } from '@/lib/crm';
import type { Tag } from '@/lib/inbox';
import type { WaNumber } from '@/lib/numbers';

const TABS = [['contacts', 'Contatos'], ['lists', 'Listas'], ['blacklist', 'Lista de bloqueio']] as const;
type TabKey = (typeof TABS)[number][0];

export default function ContactsPage() {
  const [tab, setTab] = useState<TabKey>('contacts');
  const [lists, setLists] = useState<ContactList[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [numbers, setNumbers] = useState<WaNumber[]>([]);

  const loadLists = useCallback(() => api<{ lists: ContactList[] }>('/lists').then((r) => setLists(r.lists)).catch(() => undefined), []);
  useEffect(() => {
    void loadLists();
    api<{ tags: Tag[] }>('/tags').then((r) => setTags(r.tags)).catch(() => undefined);
    api<{ numbers: WaNumber[] }>('/numbers').then((r) => setNumbers(r.numbers)).catch(() => undefined);
  }, [loadLists]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-semibold">Contatos</h1>
      <div role="tablist" className="mb-5 mt-3 flex gap-1 border-b border-slate-200">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'contacts' && <ContactsTab lists={lists} tags={tags} numbers={numbers} onListsChanged={() => void loadLists()} />}
      {tab === 'lists' && <ListsTab lists={lists} onChanged={() => void loadLists()} />}
      {tab === 'blacklist' && <BlacklistTab />}
    </div>
  );
}
