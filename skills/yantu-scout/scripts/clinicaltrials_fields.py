"""Lossless selection of ClinicalTrials modules from one fetched record."""
import hashlib
import json

MODULES = {
    'design': ('protocolSection', 'designModule'),
    'arms': ('protocolSection', 'armsInterventionsModule'),
    'eligibility': ('protocolSection', 'eligibilityModule'),
    'locations': ('protocolSection', 'contactsLocationsModule'),
    'participant_flow': ('resultsSection', 'participantFlowModule'),
    'baseline': ('resultsSection', 'baselineCharacteristicsModule'),
    'secondary_outcomes': ('protocolSection', 'outcomesModule'),
}
SECTIONS = ('full', 'overview', *MODULES, 'primary_outcomes', 'references',
            'results_index', 'outcome_result', 'adverse_events_summary', 'serious_events', 'other_events')


def select_section(record, nct_id, section, outcome_index=None, expected_last_update=None):
    protocol = record.get('protocolSection', {})
    identity = protocol.get('identificationModule', {})
    if identity.get('nctId') != nct_id:
        raise ValueError('RECORD_MISMATCH: returned NCT does not match request')
    last_update = protocol.get('statusModule', {}).get('lastUpdatePostDateStruct', {}).get('date')
    if expected_last_update and expected_last_update != last_update:
        raise ValueError('SOURCE_CHANGED: re-read from a consistent source version')
    if section not in SECTIONS:
        raise ValueError('UNKNOWN_SECTION')
    if outcome_index is not None and section != 'outcome_result':
        raise ValueError('UNEXPECTED_OUTCOME_INDEX')
    if section == 'full':
        data = record
    elif section == 'overview':
        data = {'identificationModule': identity,
                'statusModule': protocol.get('statusModule'),
                'designModule': protocol.get('designModule'),
                'sponsorCollaboratorsModule': protocol.get('sponsorCollaboratorsModule')}
    elif section in MODULES:
        root, module = MODULES[section]
        data = record.get(root, {}).get(module)
    elif section == 'primary_outcomes':
        data = protocol.get('outcomesModule', {}).get('primaryOutcomes')
    elif section == 'references':
        data = {'references': protocol.get('referencesModule'),
                'documents': record.get('documentSection', {}).get('largeDocumentModule')}
    elif section in ('results_index', 'outcome_result'):
        measures = record.get('resultsSection', {}).get('outcomeMeasuresModule', {}).get('outcomeMeasures', [])
        if section == 'results_index':
            data = [{'outcomeIndex': i, 'type': item.get('type'), 'title': item.get('title'),
                     'timeFrame': item.get('timeFrame')} for i, item in enumerate(measures)]
        else:
            if outcome_index is None or not 0 <= outcome_index < len(measures):
                raise ValueError('OUTCOME_INDEX_REQUIRED_OR_OUT_OF_RANGE: read results_index first')
            data = measures[outcome_index]
    else:
        ae = record.get('resultsSection', {}).get('adverseEventsModule')
        if ae is None:
            data = None
        else:
            context = ('frequencyThreshold', 'timeFrame', 'description', 'eventGroups')
            keys = (*context, {'serious_events': 'seriousEvents', 'other_events': 'otherEvents'}.get(section, ''))
            data = {key: ae[key] for key in keys if key in ae}
    missing = data is None or data == [] or data == {} or (isinstance(data, dict) and all(v is None for v in data.values()))
    return {'nct_id': nct_id, 'section': section, 'outcome_index': outcome_index,
            'source_last_update': last_update, 'source_digest': hashlib.sha256(
                json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            'section_complete': True, 'next_cursor': None,
            'availability': 'not_in_registry_record' if missing else 'present_in_registry_record',
            'has_results_section': 'resultsSection' in record, 'data': data,
            'boundary': 'Saved module only; preserve group IDs, denominators, units, time frames and ACTUAL/ESTIMATED. Missing is not proof of absence from other sources.'}
