import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'customer_app.dart';

class VisitsScreen extends StatelessWidget {
  const VisitsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(title: const Text('My visits'), bottom: const TabBar(tabs: [Tab(text: 'Upcoming'), Tab(text: 'Past')])),
        body: const TabBarView(children: [_AppointmentList(scope: 'upcoming'), _AppointmentList(scope: 'past')]),
      ),
    );
  }
}

class _AppointmentList extends StatelessWidget {
  const _AppointmentList({required this.scope});
  final String scope;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return AsyncView<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/portal/appointments', query: {'scope': scope})) as List).cast<Map<String, dynamic>>(),
      builder: (context, items, reload) {
        if (items.isEmpty) {
          return ListView(children: [
            EmptyState(
              icon: scope == 'upcoming' ? Icons.event_available_outlined : Icons.history,
              title: scope == 'upcoming' ? 'Nothing booked yet' : 'No past visits',
              action: scope == 'upcoming' ? FilledButton(onPressed: () => CustomerHome.of(context)?.go(CustomerHomeState.book), child: const Text('Book a visit')) : null,
            ),
          ]);
        }
        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 10),
          itemBuilder: (context, i) => _AppointmentCard(appointment: items[i], reload: reload),
        );
      },
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  const _AppointmentCard({required this.appointment, required this.reload});
  final Map<String, dynamic> appointment;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final a = appointment;
    final api = context.read<ApiClient>();
    final branch = a['branch'] as Map<String, dynamic>;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text((a['service'] as Map)['name'] as String, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
            StatusChip(a['status'] as String),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            const Icon(Icons.schedule, size: 16),
            const SizedBox(width: 6),
            Text('${dayLabel(a['date'] as String)} · ${timeLabel(a['time'] as String)} · ${a['durationMinutes']} min'),
          ]),
          const SizedBox(height: 4),
          Row(children: [
            const Icon(Icons.place_outlined, size: 16),
            const SizedBox(width: 6),
            Expanded(child: Text([branch['name'], (a['therapist'] as Map?)?['name']].whereType<String>().join(' · '))),
          ]),
          if (a['cancelReason'] != null) ...[
            const SizedBox(height: 6),
            Text(a['cancelReason'] as String, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
          ],
          if (a['canCancel'] == true) ...[
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: BusyButton(
                label: 'Cancel booking',
                outlined: true,
                onPressed: () async {
                  final ok = await confirm(context, title: 'Cancel this visit?', message: 'Your ${(a['service'] as Map)['name']} on ${dayLabel(a['date'] as String)} will be cancelled.', action: 'Cancel visit', destructive: true);
                  if (!ok) return;
                  await api.post('/portal/appointments/${a['id']}/cancel', {});
                  if (context.mounted) showInfo(context, 'Your visit was cancelled');
                  await reload();
                },
              ),
            ),
          ],
        ]),
      ),
    );
  }
}
