import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'staff_session.dart';

/// Live session: timer, start / pause / resume / complete, and clinical notes.
class SessionDetailScreen extends StatefulWidget {
  const SessionDetailScreen({super.key, required this.sessionId});
  final String sessionId;

  @override
  State<SessionDetailScreen> createState() => _SessionDetailScreenState();
}

class _SessionDetailScreenState extends State<SessionDetailScreen> {
  Map<String, dynamic>? _s;
  Object? _error;
  final _notes = TextEditingController();
  bool _notesDirty = false;

  ApiClient get _api => context.read<ApiClient>();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await _api.get('/sessions/${widget.sessionId}') as Map<String, dynamic>;
      _apply(s);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  void _apply(Map<String, dynamic> s) {
    if (!mounted) return;
    setState(() {
      _s = s;
      _error = null;
      if (!_notesDirty) _notes.text = s['notes'] as String? ?? '';
    });
  }

  Future<void> _action(String action) async {
    final s = await _api.post('/sessions/${widget.sessionId}/$action') as Map<String, dynamic>;
    _apply(s);
  }

  Future<void> _saveNotes() async {
    final s = await _api.patch('/sessions/${widget.sessionId}/notes', {'notes': _notes.text}) as Map<String, dynamic>;
    _notesDirty = false;
    _apply(s);
    if (mounted) showInfo(context, 'Notes saved');
  }

  Future<void> _complete() async {
    final ok = await confirm(context, title: 'Complete session?', message: 'This finishes the session and records it for billing. Notes you typed will be saved.', action: 'Complete');
    if (!ok) return;
    final s = await _api.post('/sessions/${widget.sessionId}/complete', {if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim()}) as Map<String, dynamic>;
    _notesDirty = false;
    _apply(s);
    if (mounted) showInfo(context, 'Session completed');
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    final staff = context.watch<StaffSession>();
    return Scaffold(
      appBar: AppBar(title: const Text('Session')),
      body: s == null
          ? (_error != null ? ErrorView(error: _error!, onRetry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(16), children: [
                _header(context, s),
                const SizedBox(height: 16),
                _controls(s),
                if (staff.can('session.notes')) ...[
                  const SectionTitle('Session notes'),
                  TextField(
                    controller: _notes,
                    minLines: 4,
                    maxLines: 10,
                    enabled: s['status'] != 'CANCELLED',
                    onChanged: (_) => setState(() => _notesDirty = true),
                    decoration: const InputDecoration(hintText: 'Pressure, focus areas, observations, advice for next visit…'),
                  ),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: BusyButton(label: 'Save notes', icon: Icons.save_outlined, outlined: true, onPressed: _notesDirty ? _saveNotes : null),
                  ),
                ],
                if (((s['previousSessions'] as List?) ?? const []).isNotEmpty) ...[
                  const SectionTitle('Previous visits'),
                  ...(s['previousSessions'] as List).cast<Map<String, dynamic>>().map((p) => Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Card(
                          child: ListTile(
                            title: Text('${(p['service'] as Map)['name']} · ${dateLabel(parseDate(p['completedAt']))}'),
                            subtitle: Text([(p['therapist'] as Map?)?['name'], p['notes']].whereType<String>().where((x) => x.isNotEmpty).join('\n')),
                          ),
                        ),
                      )),
                ],
                const SizedBox(height: 24),
              ]),
            ),
    );
  }

  Widget _header(BuildContext context, Map<String, dynamic> s) {
    final customer = s['customer'] as Map<String, dynamic>;
    final service = s['service'] as Map<String, dynamic>;
    final status = s['status'] as String;
    final expected = (service['durationMinutes'] as num?)?.toInt() ?? 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            CircleAvatar(child: Text(initials(customer['name'] as String))),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(customer['name'] as String, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text([customer['customerCode'], customer['phone']].whereType<String>().join(' · '), style: TextStyle(color: Colors.grey.shade600)),
              ]),
            ),
            StatusChip(status),
          ]),
          const Divider(height: 28),
          Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(service['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text('${expected}min planned · ${(s['therapist'] as Map)['name']}${s['room'] != null ? ' · Room ${s['room']}' : ''}', style: TextStyle(color: Colors.grey.shade600)),
              ]),
            ),
            SessionTimer(elapsedSeconds: (s['elapsedSeconds'] as num?)?.toInt() ?? 0, running: status == 'IN_PROGRESS', large: true, overAfter: expected * 60),
          ]),
        ]),
      ),
    );
  }

  Widget _controls(Map<String, dynamic> s) {
    final status = s['status'] as String;
    final staff = context.read<StaffSession>();
    if (!staff.can('session.manage')) return const SizedBox.shrink();
    switch (status) {
      case 'SCHEDULED':
        return BusyButton(label: 'Start session', icon: Icons.play_arrow, onPressed: () => _action('start'));
      case 'IN_PROGRESS':
        return Row(children: [
          Expanded(child: BusyButton(label: 'Pause', icon: Icons.pause, outlined: true, onPressed: () => _action('pause'))),
          const SizedBox(width: 10),
          Expanded(child: BusyButton(label: 'Complete', icon: Icons.check, color: Colors.green.shade700, onPressed: _complete)),
        ]);
      case 'PAUSED':
        return Row(children: [
          Expanded(child: BusyButton(label: 'Resume', icon: Icons.play_arrow, outlined: true, onPressed: () => _action('resume'))),
          const SizedBox(width: 10),
          Expanded(child: BusyButton(label: 'Complete', icon: Icons.check, color: Colors.green.shade700, onPressed: _complete)),
        ]);
      default:
        return const SizedBox.shrink();
    }
  }
}

/// Counts up from the server's elapsed time while the session runs.
class SessionTimer extends StatefulWidget {
  const SessionTimer({super.key, required this.elapsedSeconds, required this.running, this.large = false, this.overAfter});
  final int elapsedSeconds;
  final bool running;
  final bool large;
  final int? overAfter;

  @override
  State<SessionTimer> createState() => _SessionTimerState();
}

class _SessionTimerState extends State<SessionTimer> {
  Timer? _timer;
  late DateTime _base;

  @override
  void initState() {
    super.initState();
    _reset();
  }

  @override
  void didUpdateWidget(SessionTimer old) {
    super.didUpdateWidget(old);
    if (old.elapsedSeconds != widget.elapsedSeconds || old.running != widget.running) _reset();
  }

  void _reset() {
    _timer?.cancel();
    _base = clock.now();
    if (widget.running) _timer = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final seconds = widget.elapsedSeconds + (widget.running ? clock.now().difference(_base).inSeconds : 0);
    final over = widget.overAfter != null && widget.overAfter! > 0 && seconds > widget.overAfter!;
    return Text(
      duration(seconds),
      style: TextStyle(
        fontFeatures: const [FontFeature.tabularFigures()],
        fontSize: widget.large ? 28 : 16,
        fontWeight: FontWeight.w700,
        color: over ? Colors.orange.shade800 : Theme.of(context).colorScheme.primary,
      ),
    );
  }
}
