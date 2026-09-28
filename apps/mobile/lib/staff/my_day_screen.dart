import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'session_detail_screen.dart';
import 'staff_session.dart';

/// Therapist's day: the running session, assigned walk-ins, today's appointments and completed work.
class MyDayScreen extends StatelessWidget {
  const MyDayScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final session = context.watch<StaffSession>();
    return Scaffold(
      appBar: AppBar(title: const Text('My day')),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await api.get('/sessions/my-day') as Map<String, dynamic>,
        refreshInterval: const Duration(seconds: 30),
        builder: (context, day, reload) {
          final active = day['activeSession'] as Map<String, dynamic>?;
          final appts = (day['appointments'] as List).cast<Map<String, dynamic>>();
          final queue = (day['assignedQueue'] as List).cast<Map<String, dynamic>>();
          final done = (day['completed'] as List).cast<Map<String, dynamic>>();
          final stats = day['stats'] as Map<String, dynamic>;
          final pending = appts.where((a) => ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].contains(a['status'])).toList();

          Future<void> open(String id) async {
            await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SessionDetailScreen(sessionId: id)));
            await reload();
          }

          Future<void> startAppointment(Map<String, dynamic> a) async {
            final s = await api.post('/appointments/${a['id']}/start') as Map<String, dynamic>;
            await open(s['id'] as String);
          }

          Future<void> startWalkIn(Map<String, dynamic> q) async {
            final service = q['service'] as Map<String, dynamic>?;
            if (service == null) throw ApiException('VALIDATION', 'Ask the front desk to pick a service for this walk-in first.');
            final s = await api.post('/sessions', {
              'branchId': q['branchId'],
              'customerId': (q['customer'] as Map)['id'],
              'therapistId': session.therapistId,
              'serviceId': service['id'],
              'queueEntryId': q['id'],
              'startNow': true,
            }) as Map<String, dynamic>;
            await open(s['id'] as String);
          }

          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('Hello, ${session.name.split(' ').first}', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
            Text(dayLabel(day['date'] as String), style: TextStyle(color: Colors.grey.shade600)),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: StatTile(label: 'Booked', value: '${stats['appointments']}', icon: Icons.event_outlined)),
              const SizedBox(width: 10),
              Expanded(child: StatTile(label: 'Done', value: '${stats['completedToday']}', icon: Icons.check_circle_outline)),
              const SizedBox(width: 10),
              Expanded(child: StatTile(label: 'This month', value: money(stats['monthCommission'] as num, currency: session.currency), icon: Icons.payments_outlined)),
            ]),
            if (active != null) ...[
              const SectionTitle('In progress'),
              _ActiveCard(session: active, onOpen: () => open(active['id'] as String)),
            ],
            if (queue.isNotEmpty) ...[
              const SectionTitle('Walk-ins assigned to you'),
              ...queue.map((q) => _Row(
                    title: (q['customer'] as Map)['name'] as String,
                    subtitle: '#${q['queueNumber']} · ${(q['service'] as Map?)?['name'] ?? 'Service not chosen'}',
                    leading: const Icon(Icons.directions_walk),
                    action: active == null ? BusyButton(label: 'Start', icon: Icons.play_arrow, onPressed: () => startWalkIn(q)) : null,
                  )),
            ],
            SectionTitle('Appointments', trailing: Text('${pending.length} to go', style: TextStyle(color: Colors.grey.shade600, fontSize: 12))),
            if (appts.isEmpty) const EmptyState(icon: Icons.event_available_outlined, title: 'No appointments today', message: 'Walk-ins assigned to you will appear here.'),
            ...appts.map((a) {
              final status = a['status'] as String;
              final canStart = active == null && ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].contains(status);
              return _Row(
                title: (a['customer'] as Map)['name'] as String,
                subtitle: '${timeLabel(a['localStart'] as String)} – ${timeLabel(a['localEnd'] as String)} · ${(a['service'] as Map)['name']}',
                leading: const Icon(Icons.event_outlined),
                trailing: StatusChip(status),
                action: canStart ? BusyButton(label: 'Start', icon: Icons.play_arrow, onPressed: () => startAppointment(a)) : null,
              );
            }),
            if (done.isNotEmpty) ...[
              const SectionTitle('Completed today'),
              ...done.map((s) => _Row(
                    title: (s['customer'] as Map)['name'] as String,
                    subtitle: '${(s['service'] as Map)['name']} · ${timeLabel(_hhmm(parseDate(s['completedAt'])))}',
                    leading: Icon(Icons.check_circle, color: Colors.green.shade600),
                    onTap: () => open(s['id'] as String),
                  )),
            ],
            const SizedBox(height: 24),
          ]);
        },
      ),
    );
  }
}

String _hhmm(DateTime? d) => d == null ? '' : '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

class _ActiveCard extends StatelessWidget {
  const _ActiveCard({required this.session, required this.onOpen});
  final Map<String, dynamic> session;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final paused = session['status'] == 'PAUSED';
    return Card(
      color: scheme.primaryContainer.withValues(alpha: 0.5),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Icon(paused ? Icons.pause_circle : Icons.timelapse, color: scheme.primary, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text((session['customer'] as Map)['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                Text('${(session['service'] as Map)['name']} · ${paused ? 'Paused' : 'Running'}', style: TextStyle(color: Colors.grey.shade700)),
              ]),
            ),
            SessionTimer(elapsedSeconds: (session['elapsedSeconds'] as num?)?.toInt() ?? 0, running: !paused),
            const Icon(Icons.chevron_right),
          ]),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, required this.subtitle, required this.leading, this.trailing, this.action, this.onTap});
  final String title;
  final String subtitle;
  final Widget leading;
  final Widget? trailing;
  final Widget? action;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        child: ListTile(
          onTap: onTap,
          leading: leading,
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(subtitle),
            if (trailing != null || action != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(children: [?trailing, const Spacer(), if (action != null) SizedBox(height: 36, child: action)]),
              ),
          ]),
        ),
      ),
    );
  }
}
