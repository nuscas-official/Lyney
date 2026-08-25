import React, { useState } from 'react';
import {
  Ghost, Plus, Pencil, Trash2, ChevronDown, ChevronUp, X, Dices, Image as ImageIcon,
  Eye, EyeOff, CheckCircle2, XCircle,
} from 'lucide-react';
import { Token, PaperChip, BoardHeading } from './BoardBits';
import { getNpcImageUrl } from '../lib/supabase';
import { NpcEventCatalogEntry, NpcEventScenario, NpcEventOption, NpcOutcomeMode } from '../types/database';

/* ==========================================================================
   NPC EVENT CATALOG EDITOR
   The host-only "gallery" for NPC events — never reachable by a player, per
   npc_events/npc_event_scenarios/npc_event_options carrying no select policy
   at all. Three nested levels (event -> scenarios -> options), each edited
   through a small modal in the same board-scrim/panel/animate-pop language as
   HostDashboard's existing "Grant a card" modal.
   ========================================================================== */

export interface SaveEventInput { id?: string; title: string; imagePath: string | null; active: boolean }
export interface SaveScenarioInput { id?: string; npcEventId: string; description: string; weight: number; active: boolean }
export interface SaveOptionInput {
  id?: string;
  scenarioId: string;
  label: string;
  outcomeMode: NpcOutcomeMode;
  /** Required in both modes now -- the prompt shown at pick time, fixed or judged. */
  effect: string;
  successEffect: string | null;
  failureEffect: string | null;
  sortOrder: number;
}

interface Props {
  catalog: NpcEventCatalogEntry[];
  imageChoices: string[];
  onSaveEvent: (input: SaveEventInput) => Promise<void>;
  onDeleteEvent: (id: string) => Promise<void>;
  onSaveScenario: (input: SaveScenarioInput) => Promise<void>;
  onDeleteScenario: (id: string) => Promise<void>;
  onSaveOption: (input: SaveOptionInput) => Promise<void>;
  onDeleteOption: (id: string) => Promise<void>;
}

type EventModalState = { id?: string; title: string; imagePath: string; active: boolean } | null;
type ScenarioModalState = { id?: string; npcEventId: string; description: string; weight: number; active: boolean } | null;
type OptionModalState = {
  id?: string;
  scenarioId: string;
  label: string;
  outcomeMode: NpcOutcomeMode;
  effect: string;
  successEffect: string;
  failureEffect: string;
  sortOrder: number;
} | null;

export const NpcEventCatalogEditor: React.FC<Props> = ({
  catalog, imageChoices,
  onSaveEvent, onDeleteEvent, onSaveScenario, onDeleteScenario, onSaveOption, onDeleteOption,
}) => {
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [expandedScenarios, setExpandedScenarios] = useState<Record<string, boolean>>({});
  const [eventModal, setEventModal] = useState<EventModalState>(null);
  const [scenarioModal, setScenarioModal] = useState<ScenarioModalState>(null);
  const [optionModal, setOptionModal] = useState<OptionModalState>(null);
  const [busy, setBusy] = useState(false);

  const toggleEvent = (id: string) => setExpandedEvents((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleScenario = (id: string) => setExpandedScenarios((prev) => ({ ...prev, [id]: !prev[id] }));

  const scenarioOdds = (event: NpcEventCatalogEntry, scenario: NpcEventScenario) => {
    const totalWeight = event.scenarios
      .filter((s) => s.active)
      .reduce((sum, s) => sum + s.weight, 0);
    return totalWeight > 0 ? ((scenario.weight / totalWeight) * 100).toFixed(1) : '0.0';
  };

  const submitEvent = async () => {
    if (!eventModal || !eventModal.title.trim() || busy) return;
    setBusy(true);
    try {
      await onSaveEvent({
        id: eventModal.id,
        title: eventModal.title.trim(),
        imagePath: eventModal.imagePath || null,
        active: eventModal.active,
      });
      setEventModal(null);
    } finally {
      setBusy(false);
    }
  };

  const submitScenario = async () => {
    if (!scenarioModal || !scenarioModal.description.trim() || busy) return;
    setBusy(true);
    try {
      await onSaveScenario({
        id: scenarioModal.id,
        npcEventId: scenarioModal.npcEventId,
        description: scenarioModal.description.trim(),
        weight: Math.max(1, scenarioModal.weight || 1),
        active: scenarioModal.active,
      });
      setScenarioModal(null);
    } finally {
      setBusy(false);
    }
  };

  const optionModalValid = (o: NonNullable<OptionModalState>) =>
    o.label.trim() !== '' &&
    o.effect.trim() !== '' &&
    (o.outcomeMode === 'fixed' || (o.successEffect.trim() !== '' && o.failureEffect.trim() !== ''));

  const submitOption = async () => {
    if (!optionModal || !optionModalValid(optionModal) || busy) return;
    setBusy(true);
    try {
      await onSaveOption({
        id: optionModal.id,
        scenarioId: optionModal.scenarioId,
        label: optionModal.label.trim(),
        outcomeMode: optionModal.outcomeMode,
        effect: optionModal.effect.trim(),
        successEffect: optionModal.outcomeMode === 'judged' ? optionModal.successEffect.trim() : null,
        failureEffect: optionModal.outcomeMode === 'judged' ? optionModal.failureEffect.trim() : null,
        sortOrder: optionModal.sortOrder || 0,
      });
      setOptionModal(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="panel p-5 flex flex-wrap items-center justify-between gap-3">
        <BoardHeading
          icon={Ghost}
          tone="gold"
          title="NPC event catalog"
          subtitle="Host-only — this never appears in the player gallery, on purpose"
        />
        <button
          onClick={() => setEventModal({ title: '', imagePath: '', active: true })}
          className="btn-leaf !py-2.5 !px-4 !text-xs"
        >
          <Plus className="w-4 h-4" strokeWidth={2.75} /> Add NPC event
        </button>
      </div>

      {catalog.length === 0 ? (
        <div className="path-dashed p-10 text-center">
          <Token tone="paper" size="lg" icon={Ghost} className="mx-auto mb-3 opacity-70" />
          <h3 className="font-display text-base font-extrabold text-ink-700">No NPC events yet</h3>
          <p className="text-xs font-semibold text-ink-500 max-w-xs mx-auto mt-1">
            Add one, give it a scenario or two, and it shows up in the trigger picker on the Room tab.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {catalog.map((event) => (
            <div key={event.id} className="panel overflow-hidden">
              {/* Event row */}
              <div className="px-4 py-3.5 path-strip flex items-center gap-3">
                <button
                  onClick={() => toggleEvent(event.id)}
                  className="shrink-0 btn-icon !w-8 !h-8"
                  title={expandedEvents[event.id] ? 'Collapse' : 'Expand scenarios'}
                >
                  {expandedEvents[event.id] ? (
                    <ChevronUp className="w-4 h-4" strokeWidth={2.75} />
                  ) : (
                    <ChevronDown className="w-4 h-4" strokeWidth={2.75} />
                  )}
                </button>

                <Token
                  tone="gold"
                  size="md"
                  icon={event.image_path ? undefined : Ghost}
                  imageSrc={event.image_path ? getNpcImageUrl(event.image_path) : undefined}
                />

                <div className="min-w-0 flex-1">
                  <h4 className="font-display text-sm font-extrabold text-ink-800 truncate">{event.title}</h4>
                  <p className="text-[11px] font-semibold text-ink-500">
                    {event.scenarios.length} {event.scenarios.length === 1 ? 'scenario' : 'scenarios'}
                  </p>
                </div>

                <PaperChip tone={event.active ? 'leaf' : 'paper'}>{event.active ? 'Active' : 'Inactive'}</PaperChip>

                <button
                  onClick={() =>
                    setEventModal({
                      id: event.id,
                      title: event.title,
                      imagePath: event.image_path || '',
                      active: event.active,
                    })
                  }
                  className="btn-icon !w-8 !h-8"
                  title="Edit event"
                >
                  <Pencil className="w-3.5 h-3.5" strokeWidth={2.75} />
                </button>
                <button
                  onClick={() => onDeleteEvent(event.id)}
                  className="btn-icon !w-8 !h-8 hover:!bg-pip-red hover:!text-white"
                  title="Delete event"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={2.75} />
                </button>
              </div>

              {/* Scenarios */}
              {expandedEvents[event.id] && (
                <div className="p-4 space-y-3 bg-parchment-50">
                  {event.scenarios.map((scenario) => (
                    <div key={scenario.id} className="slab p-3 space-y-2.5">
                      <div className="flex items-start gap-2.5">
                        <button
                          onClick={() => toggleScenario(scenario.id)}
                          className="shrink-0 btn-icon !w-7 !h-7 mt-0.5"
                          title={expandedScenarios[scenario.id] ? 'Collapse options' : 'Expand options'}
                        >
                          {expandedScenarios[scenario.id] ? (
                            <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.75} />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.75} />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-ink-800 leading-snug whitespace-pre-line">{scenario.description}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <PaperChip tone={scenario.active ? 'leaf' : 'paper'}>
                              {scenario.active ? 'Active' : 'Inactive'}
                            </PaperChip>
                            <span className="chip bg-pip-cyan font-mono" title="Odds among this event's active scenarios">
                              <Dices className="w-3 h-3" strokeWidth={2.75} />
                              weight {scenario.weight} · {scenarioOdds(event, scenario)}%
                            </span>
                            <span className="text-[11px] font-semibold text-ink-400">
                              {scenario.options.length} {scenario.options.length === 1 ? 'option' : 'options'}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() =>
                              setScenarioModal({
                                id: scenario.id,
                                npcEventId: event.id,
                                description: scenario.description,
                                weight: scenario.weight,
                                active: scenario.active,
                              })
                            }
                            className="btn-icon !w-7 !h-7"
                            title="Edit scenario"
                          >
                            <Pencil className="w-3.5 h-3.5" strokeWidth={2.75} />
                          </button>
                          <button
                            onClick={() => onDeleteScenario(scenario.id)}
                            className="btn-icon !w-7 !h-7 hover:!bg-pip-red hover:!text-white"
                            title="Delete scenario"
                          >
                            <Trash2 className="w-3.5 h-3.5" strokeWidth={2.75} />
                          </button>
                        </div>
                      </div>

                      {/* Options */}
                      {expandedScenarios[scenario.id] && (
                        <div className="pl-9 space-y-1.5">
                          {scenario.options.map((option: NpcEventOption) => (
                            <div key={option.id} className="flex items-start gap-2 bg-white rounded-lg border-2 border-ink-900/10 px-2.5 py-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-xs font-extrabold text-ink-800">{option.label}</p>
                                  {option.outcome_mode === 'judged' && (
                                    <span className="chip !py-0.5 !px-1.5 bg-pip-violet text-white !text-[10px]" title="The host rules success or failure after the player picks this">
                                      <EyeOff className="w-2.5 h-2.5" strokeWidth={3} /> Host judges
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] font-semibold text-ink-500 leading-snug mt-0.5 whitespace-pre-line">
                                  {option.effect}
                                </p>
                                {option.outcome_mode === 'judged' && (
                                  <div className="mt-1 space-y-1">
                                    <p className="text-[11px] font-semibold text-pip-leaf leading-snug whitespace-pre-line">
                                      <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-0.5" strokeWidth={2.75} />
                                      {option.success_effect}
                                    </p>
                                    <p className="text-[11px] font-semibold text-crimson-600 leading-snug whitespace-pre-line">
                                      <XCircle className="w-3 h-3 inline mr-1 -mt-0.5" strokeWidth={2.75} />
                                      {option.failure_effect}
                                    </p>
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() =>
                                    setOptionModal({
                                      id: option.id,
                                      scenarioId: scenario.id,
                                      label: option.label,
                                      outcomeMode: option.outcome_mode,
                                      effect: option.effect || '',
                                      successEffect: option.success_effect || '',
                                      failureEffect: option.failure_effect || '',
                                      sortOrder: option.sort_order,
                                    })
                                  }
                                  className="btn-icon !w-6 !h-6"
                                  title="Edit option"
                                >
                                  <Pencil className="w-3 h-3" strokeWidth={2.75} />
                                </button>
                                <button
                                  onClick={() => onDeleteOption(option.id)}
                                  className="btn-icon !w-6 !h-6 hover:!bg-pip-red hover:!text-white"
                                  title="Delete option"
                                >
                                  <Trash2 className="w-3 h-3" strokeWidth={2.75} />
                                </button>
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() =>
                              setOptionModal({
                                scenarioId: scenario.id,
                                label: '',
                                outcomeMode: 'fixed',
                                effect: '',
                                successEffect: '',
                                failureEffect: '',
                                sortOrder: scenario.options.length,
                              })
                            }
                            className="btn-paper w-full !py-1.5 !text-[11px]"
                          >
                            <Plus className="w-3 h-3" strokeWidth={2.75} /> Add option
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  <button
                    onClick={() =>
                      setScenarioModal({ npcEventId: event.id, description: '', weight: 1, active: true })
                    }
                    className="btn-paper w-full !py-2 !text-xs"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={2.75} /> Add scenario
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Event Modal */}
      {eventModal && (
        <div className="board-scrim">
          <div className="panel max-w-sm w-full p-6 animate-pop relative">
            <button onClick={() => setEventModal(null)} className="btn-icon !w-8 !h-8 absolute top-3 right-3">
              <X className="w-4 h-4" strokeWidth={3} />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <Token tone="gold" size="md" icon={Ghost} />
              <h3 className="font-display text-lg font-extrabold text-ink-800 leading-tight">
                {eventModal.id ? 'Edit NPC event' : 'New NPC event'}
              </h3>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="field-label">Title</label>
                <input
                  type="text"
                  value={eventModal.title}
                  onChange={(e) => setEventModal({ ...eventModal, title: e.target.value })}
                  placeholder="e.g. The Wandering Merchant"
                  className="field"
                  autoFocus
                />
              </div>

              <div>
                <label className="field-label">Portrait</label>
                {imageChoices.length === 0 ? (
                  <p className="text-[11px] font-semibold text-ink-400">
                    Upload an image to the npc-images bucket in Supabase, then it'll show up here.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2.5 py-1">
                    <button
                      type="button"
                      onClick={() => setEventModal({ ...eventModal, imagePath: '' })}
                      title="No portrait"
                      className={`token !rounded-lg w-12 h-12 bg-parchment-100 text-ink-400 ${
                        eventModal.imagePath === '' ? 'ring-4 ring-crimson-500' : ''
                      }`}
                    >
                      <ImageIcon className="w-5 h-5" strokeWidth={2.5} />
                    </button>
                    {imageChoices.map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => setEventModal({ ...eventModal, imagePath: path })}
                        title={path}
                        className={`token !rounded-lg w-12 h-12 overflow-hidden ${
                          eventModal.imagePath === path ? 'ring-4 ring-crimson-500' : ''
                        }`}
                      >
                        <img src={getNpcImageUrl(path)} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eventModal.active}
                  onChange={(e) => setEventModal({ ...eventModal, active: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-xs font-bold text-ink-700">
                  Active (shows up in the trigger picker)
                </span>
              </label>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setEventModal(null)} className="btn-paper flex-1 !py-2.5 !text-xs">
                Cancel
              </button>
              <button
                onClick={submitEvent}
                disabled={busy || !eventModal.title.trim()}
                className="btn-leaf flex-1 !py-2.5 !text-xs disabled:opacity-60"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scenario Modal */}
      {scenarioModal && (
        <div className="board-scrim">
          <div className="panel max-w-sm w-full p-6 animate-pop relative">
            <button onClick={() => setScenarioModal(null)} className="btn-icon !w-8 !h-8 absolute top-3 right-3">
              <X className="w-4 h-4" strokeWidth={3} />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <Token tone="cyan" size="md" icon={Dices} />
              <h3 className="font-display text-lg font-extrabold text-ink-800 leading-tight">
                {scenarioModal.id ? 'Edit scenario' : 'New scenario'}
              </h3>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="field-label">Description</label>
                <textarea
                  value={scenarioModal.description}
                  onChange={(e) => setScenarioModal({ ...scenarioModal, description: e.target.value })}
                  placeholder="What the player sees, a sentence or two…"
                  className="field !h-24 resize-none"
                  autoFocus
                />
              </div>

              <div>
                <label className="field-label">Weight (odds among this event's scenarios)</label>
                <input
                  type="number"
                  min="1"
                  value={scenarioModal.weight}
                  onChange={(e) =>
                    setScenarioModal({ ...scenarioModal, weight: Math.max(1, parseInt(e.target.value, 10) || 1) })
                  }
                  className="field !w-24"
                />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scenarioModal.active}
                  onChange={(e) => setScenarioModal({ ...scenarioModal, active: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-xs font-bold text-ink-700">
                  Active (eligible for random pick and the scenario picker)
                </span>
              </label>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setScenarioModal(null)} className="btn-paper flex-1 !py-2.5 !text-xs">
                Cancel
              </button>
              <button
                onClick={submitScenario}
                disabled={busy || !scenarioModal.description.trim()}
                className="btn-leaf flex-1 !py-2.5 !text-xs disabled:opacity-60"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Option Modal */}
      {optionModal && (
        <div className="board-scrim">
          <div className="panel max-w-sm w-full p-6 animate-pop relative">
            <button onClick={() => setOptionModal(null)} className="btn-icon !w-8 !h-8 absolute top-3 right-3">
              <X className="w-4 h-4" strokeWidth={3} />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <Token tone="violet" size="md" icon={Plus} />
              <h3 className="font-display text-lg font-extrabold text-ink-800 leading-tight">
                {optionModal.id ? 'Edit option' : 'New option'}
              </h3>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="field-label">Option label (what the player taps)</label>
                <input
                  type="text"
                  value={optionModal.label}
                  onChange={(e) => setOptionModal({ ...optionModal, label: e.target.value })}
                  placeholder="e.g. Accept and think seriously"
                  className="field"
                  autoFocus
                />
              </div>

              <div>
                <label className="field-label">When they pick it…</label>
                <div className="flex gap-1 p-1 rounded-xl bg-parchment-200 border-[2.5px] border-ink-900">
                  <button
                    type="button"
                    onClick={() => setOptionModal({ ...optionModal, outcomeMode: 'fixed' })}
                    className={`flex-1 py-2 rounded-lg font-display font-bold text-xs transition-colors flex items-center justify-center gap-1.5 ${
                      optionModal.outcomeMode === 'fixed' ? 'bg-pip-gold text-ink-900 shadow-sticker-sm' : 'text-ink-500'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" strokeWidth={2.75} /> Show effect right away
                  </button>
                  <button
                    type="button"
                    onClick={() => setOptionModal({ ...optionModal, outcomeMode: 'judged' })}
                    className={`flex-1 py-2 rounded-lg font-display font-bold text-xs transition-colors flex items-center justify-center gap-1.5 ${
                      optionModal.outcomeMode === 'judged' ? 'bg-pip-violet text-white shadow-sticker-sm' : 'text-ink-500'
                    }`}
                  >
                    <EyeOff className="w-3.5 h-3.5" strokeWidth={2.75} /> Host judges after
                  </button>
                </div>
                <p className="text-[11px] font-semibold text-ink-400 mt-1.5">
                  {optionModal.outcomeMode === 'fixed'
                    ? 'The effect below is the whole outcome, shown the instant they pick the option.'
                    : 'The effect below is shown the instant they pick it too -- but only as a prompt (e.g. "this is a skill check"). The success/failure text stays hidden until you rule from the room feed.'}
                </p>
              </div>

              <div>
                <label className="field-label">
                  {optionModal.outcomeMode === 'fixed' ? 'Effect (shown the instant they pick it)' : 'Prompt (shown the instant they pick it)'}
                </label>
                <textarea
                  value={optionModal.effect}
                  onChange={(e) => setOptionModal({ ...optionModal, effect: e.target.value })}
                  placeholder={
                    optionModal.outcomeMode === 'fixed'
                      ? 'What happens as a result…'
                      : 'What the player sees while they wait, e.g. "You attempt the ritual — this could go either way."'
                  }
                  className="field !h-24 resize-none"
                />
              </div>

              {optionModal.outcomeMode === 'judged' && (
                <>
                  <div>
                    <label className="field-label">
                      <CheckCircle2 className="w-3.5 h-3.5 inline text-pip-leaf -mt-0.5 mr-1" strokeWidth={2.75} />
                      Success text
                    </label>
                    <textarea
                      value={optionModal.successEffect}
                      onChange={(e) => setOptionModal({ ...optionModal, successEffect: e.target.value })}
                      placeholder="What happens if you rule it a success…"
                      className="field !h-20 resize-none"
                    />
                  </div>
                  <div>
                    <label className="field-label">
                      <XCircle className="w-3.5 h-3.5 inline text-crimson-600 -mt-0.5 mr-1" strokeWidth={2.75} />
                      Failure text
                    </label>
                    <textarea
                      value={optionModal.failureEffect}
                      onChange={(e) => setOptionModal({ ...optionModal, failureEffect: e.target.value })}
                      placeholder="What happens if you rule it a failure…"
                      className="field !h-20 resize-none"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <button onClick={() => setOptionModal(null)} className="btn-paper flex-1 !py-2.5 !text-xs">
                Cancel
              </button>
              <button
                onClick={submitOption}
                disabled={busy || !optionModalValid(optionModal)}
                className="btn-leaf flex-1 !py-2.5 !text-xs disabled:opacity-60"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
