import {
  FloatingPanel,
  Hint,
  IconButton,
  ListRow,
  Notice,
  ProgressBar,
  ReadoutItem,
  ReadoutStrip,
  ResultList,
  ScaleRule,
  SearchField,
  SectionLabel,
  SwitchRow,
} from '@aegis/ui';
import { Building2, Maximize, Minus, Plane, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { focusLocation, focusZoom, startMapBinding } from '../../map/binding';
import { mapController } from '../../map/controller';
import { formatCoordinates, scaleBar } from '../../map/features';
import type { LayerGroup } from '../../map/style';
import { searchLocations, type SearchResult } from '../../reference/queries';
import { setGroupVisible, useMapStore } from '../../state/map-store';
import { useReferenceStore } from '../../state/reference-store';
import { useAsync } from '../shared/useAsync';
import { SelectionDetail } from './SelectionDetail';

/** Mounts the application's single map into this screen. The map itself is not a React tree. */
function MapSurface() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = mapController();
    startMapBinding();
    const element = host.current;
    element?.append(controller.element);
    controller.resize();
    const observer = new ResizeObserver(() => {
      controller.resize();
    });
    if (element) observer.observe(element);
    return () => {
      observer.disconnect();
      controller.element.remove();
    };
  }, []);

  return <div ref={host} className="absolute inset-0" />;
}

const LAYER_LABELS: readonly { group: LayerGroup; label: string }[] = [
  { group: 'aerodromes', label: 'Aerodromes' },
  { group: 'runways', label: 'Runways' },
  { group: 'cities', label: 'Cities' },
  { group: 'countryNames', label: 'Country names' },
  { group: 'borders', label: 'Borders' },
  { group: 'graticule', label: 'Graticule' },
];

function LayerPanel() {
  const visible = useMapStore((state) => state.visible);
  return (
    <FloatingPanel className="w-48 p-2">
      <SectionLabel className="px-1.5 pb-1">Reference layers</SectionLabel>
      {LAYER_LABELS.map(({ group, label }) => (
        <SwitchRow
          key={group}
          label={label}
          checked={visible[group]}
          onChange={(checked) => {
            setGroupVisible(group, checked);
          }}
        />
      ))}
      <SectionLabel className="px-1.5 pt-2 pb-1">Simulation layers</SectionLabel>
      <div className="px-1.5 pb-1">
        <Hint>None yet. Aircraft and missions arrive in later phases.</Hint>
      </div>
    </FloatingPanel>
  );
}

function SearchPanel() {
  const [query, setQuery] = useState('');
  const term = query.trim();
  const results = useAsync(`search:${term}`, () => searchLocations(term));
  const rows: SearchResult[] = results.status === 'ready' ? results.value : [];

  return (
    <FloatingPanel className="w-80">
      <div className="p-2">
        <SearchField
          label="Find a location"
          placeholder="Name, ICAO or IATA code"
          value={query}
          onChange={setQuery}
        />
      </div>
      {term.length >= 2 && (
        <ResultList>
          {rows.map((row) => (
            <ListRow
              key={row.id}
              icon={row.kind === 'city' ? Building2 : Plane}
              primary={row.name}
              secondary={[row.municipality, row.countryIso2].filter(Boolean).join(', ')}
              code={row.code ?? undefined}
              onSelect={() => {
                focusLocation(row.id, row.lat, row.lon, focusZoom(row.kind));
                setQuery('');
              }}
            />
          ))}
          {results.status === 'ready' && rows.length === 0 && (
            <div className="px-2.5 py-2">
              <Hint>No aerodrome or city matches.</Hint>
            </div>
          )}
          {results.status === 'failed' && (
            <div className="px-2.5 py-2">
              <Hint>Search failed: {results.error}</Hint>
            </div>
          )}
        </ResultList>
      )}
    </FloatingPanel>
  );
}

function ZoomControls() {
  const controller = mapController();
  return (
    <FloatingPanel className="flex flex-col p-0.5">
      <IconButton
        icon={Plus}
        label="Zoom in"
        onClick={() => {
          controller.zoomBy(1);
        }}
      />
      <IconButton
        icon={Minus}
        label="Zoom out"
        onClick={() => {
          controller.zoomBy(-1);
        }}
      />
      <IconButton
        icon={Maximize}
        label="Show the whole world"
        onClick={() => {
          controller.resetView();
        }}
      />
    </FloatingPanel>
  );
}

/**
 * Pointer position, zoom and scale. These change continuously, so they are written straight to
 * the DOM through refs; this component renders once.
 */
function MapReadout() {
  const position = useRef<HTMLSpanElement>(null);
  const zoom = useRef<HTMLSpanElement>(null);
  const rule = useRef<HTMLSpanElement>(null);
  const distance = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controller = mapController();
    const stopPointer = controller.onPointer((pointer) => {
      if (position.current) {
        position.current.textContent = pointer ? formatCoordinates(pointer.lat, pointer.lon) : '';
      }
    });
    const stopView = controller.onView((view) => {
      if (zoom.current) zoom.current.textContent = view.zoom.toFixed(1);
      const scale = scaleBar(view.metresPerPixel);
      if (rule.current) rule.current.style.width = `${scale.widthPx}px`;
      if (distance.current) distance.current.textContent = scale.label;
    });
    return () => {
      stopPointer();
      stopView();
    };
  }, []);

  return (
    <ReadoutStrip>
      <ReadoutItem label="Pointer" widthCh={24} valueRef={position} />
      <ReadoutItem label="Zoom" widthCh={4} valueRef={zoom} />
      <ScaleRule ruleRef={rule} labelRef={distance} />
      <ReadoutItem label="Basemap">Natural Earth</ReadoutItem>
      <ReadoutItem label="Aerodromes">OurAirports</ReadoutItem>
    </ReadoutStrip>
  );
}

/** Shown over the map until the reference data shipped with the build is in the database. */
function ReferenceStatus() {
  const reference = useReferenceStore();
  const referenceError = useMapStore((state) => state.referenceError);
  const loaded = useMapStore((state) => state.referenceLoaded);

  if (reference.phase === 'failed') {
    return (
      <Notice tone="critical" title="Reference data could not be installed">
        {reference.error} The map shows geography only. In a development checkout, run{' '}
        <code>npm run data:build</code> and restart.
      </Notice>
    );
  }
  if (referenceError) {
    return (
      <Notice tone="critical" title="Reference data could not be read">
        {referenceError}
      </Notice>
    );
  }
  if (reference.phase === 'installing') {
    return (
      <FloatingPanel className="flex w-80 flex-col gap-2 p-3">
        <SectionLabel>Installing reference data</SectionLabel>
        <Hint>
          First launch: loading {reference.dataset} ({reference.step} of {reference.steps}). This
          happens once and needs no connection.
        </Hint>
        <ProgressBar
          label="Reference data installation"
          value={reference.steps === 0 ? 0 : (reference.step - 1) / reference.steps}
        />
      </FloatingPanel>
    );
  }
  if (!loaded) {
    return (
      <FloatingPanel className="p-3">
        <Hint>Reading reference locations.</Hint>
      </FloatingPanel>
    );
  }
  return null;
}

/** The world map: the main operational surface. */
export function OperationsScreen() {
  const selection = useMapStore((state) => state.selection);
  return (
    <div className="flex size-full">
      <div className="relative min-w-0 flex-1">
        <MapSurface />
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="pointer-events-auto flex flex-col gap-2">
              <SearchPanel />
              <ReferenceStatus />
            </div>
            <div className="pointer-events-auto">
              <LayerPanel />
            </div>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="pointer-events-auto">
              <MapReadout />
            </div>
            <div className="pointer-events-auto">
              <ZoomControls />
            </div>
          </div>
        </div>
      </div>
      {selection && <SelectionDetail selection={selection} />}
    </div>
  );
}
