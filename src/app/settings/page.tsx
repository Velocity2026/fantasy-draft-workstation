import { prisma } from '@/lib/db';
import { getConfig } from '@/lib/config';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Separator,
} from '@/components/ui/primitives';
import { ActionButton, ActionForm } from '@/components/action-button';
import { saveSettings, setMyTeam, syncNow } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const cfg = await getConfig();
  const league = cfg.leagueId ? await prisma.league.findUnique({ where: { id: cfg.leagueId } }) : null;
  const members = league
    ? await prisma.leagueMember.findMany({ where: { leagueId: league.id }, orderBy: { displayName: 'asc' } })
    : [];

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Stored in the database, not in files — safe to change minutes before a draft.
        </p>
      </div>

      {/* --- League ------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>League</CardTitle>
          <CardDescription>
            Find your league id in the Sleeper web address:{' '}
            <code className="rounded bg-muted px-1">sleeper.com/leagues/<strong>1234567890</strong>/team</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveSettings} submitLabel="Save settings">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="leagueId">Sleeper league id</Label>
                <Input id="leagueId" name="leagueId" defaultValue={cfg.leagueId ?? ''} placeholder="1234567890" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sleeperUsername">Your Sleeper username</Label>
                <Input
                  id="sleeperUsername"
                  name="sleeperUsername"
                  defaultValue={cfg.sleeperUsername ?? ''}
                  placeholder="craig"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="season">Season</Label>
                <Input id="season" name="season" defaultValue={cfg.season} className="tabular" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="myDraftSlot">Your draft slot</Label>
                <Input
                  id="myDraftSlot"
                  name="myDraftSlot"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={cfg.myDraftSlot ?? ''}
                  placeholder="auto"
                  className="tabular"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to read it from Sleeper once the draft order is set.
                </p>
              </div>
            </div>

            <Separator className="my-2" />

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="replacementMethod">Replacement level</Label>
                <Select id="replacementMethod" name="replacementMethod" defaultValue={cfg.replacementMethod}>
                  <option value="BLENDED">Blended (recommended)</option>
                  <option value="STARTER_COUNT">Starters only</option>
                  <option value="LAST_STARTER">Last startable player</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Blended accounts for flex and bench demand — best for a shallow 10-team league.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="needWeight">Roster-need weight</Label>
                <Input
                  id="needWeight"
                  name="needWeight"
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  defaultValue={cfg.needWeight}
                  className="tabular"
                />
                <p className="text-xs text-muted-foreground">0 = pure value, 1 = need-driven.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="riskAversion">Risk aversion</Label>
                <Input
                  id="riskAversion"
                  name="riskAversion"
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  defaultValue={cfg.riskAversion}
                  className="tabular"
                />
                <p className="text-xs text-muted-foreground">Discounts injured and age-cliff players.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="boardOverrideWeight">Your-board weight</Label>
                <Input
                  id="boardOverrideWeight"
                  name="boardOverrideWeight"
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  defaultValue={cfg.boardOverrideWeight}
                  className="tabular"
                />
                <p className="text-xs text-muted-foreground">How hard your manual ranks pull the model.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="draftPollMs">Draft poll interval (ms)</Label>
                <Input
                  id="draftPollMs"
                  name="draftPollMs"
                  type="number"
                  step={500}
                  min={1000}
                  max={30000}
                  defaultValue={cfg.draftPollMs}
                  className="tabular"
                />
              </div>
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      {/* --- Which team is mine ------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Your team</CardTitle>
          <CardDescription>
            Recommendations depend on knowing which roster is yours. Set it explicitly if the username match missed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length ? (
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-accent/50">
                  <div className="text-sm">
                    <span className="font-medium">{m.displayName}</span>
                    {m.teamName ? <span className="text-muted-foreground"> · {m.teamName}</span> : null}
                  </div>
                  {m.isMe ? (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">This is you</span>
                  ) : (
                    <ActionButton action={() => setMyTeam(m.id)} variant="outline" size="sm">
                      That&apos;s me
                    </ActionButton>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Import the league first.</p>
          )}
        </CardContent>
      </Card>

      {/* --- Data --------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Data</CardTitle>
          <CardDescription>Each of these is safe to run repeatedly.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start gap-3">
          <ActionButton action={() => syncNow('players')} variant="outline">
            Sync players
          </ActionButton>
          <ActionButton action={() => syncNow('league')} variant="outline">
            Sync league &amp; drafts
          </ActionButton>
          <ActionButton action={() => syncNow('history')} variant="outline">
            Import past seasons
          </ActionButton>
          <ActionButton action={() => syncNow('market')} variant="outline">
            Refresh market
          </ActionButton>
        </CardContent>
      </Card>
    </div>
  );
}
