import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'branch_picker.dart';
import 'session_detail_screen.dart';
import 'staff_session.dart';

/// Today's sessions at the selected branch (front desk and managers).
class SessionsScreen extends StatelessWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final staff = context.watch<StaffSession>();
    return Scaffold(
      appBar: AppBar(title: const Text("Today's sessions"), actions: const [BranchPicker()]),
      body: AsyncView<List<Map<String, dynamic>>>(
        key: ValueKey(staff.branchId),
        refreshInterval: const Duration(seconds: 30),
        load: () async => (await api.page('/sessions', query: {'date': isoDate(DateTime.now()), 'branchId': staff.branchId, 'pageSize': 100})).items,
        builder: (context, items, reload) {
          if (items.isEmpty) {
            return ListView(children: const [EmptyState(icon: Icons.spa_outlined, title: 'No sessions yet today', message: 'Sessions appear here as therapists start them.')]);
          }
          const order = {'IN_PROGRESS': 0, 'PAUSED': 1, 'SCHEDULED': 2, 'COMPLETED': 3, 'CANCELLED': 4};
          final sorted = [...items]..sort((a, b) => (order[a['status']] ?? 9).compareTo(order[b['status']] ?? 9));
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: sorted.length,
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (context, i) {
              final s = sorted[i];
              final started = parseDate(s['startedAt']);
              return Card(
                child: ListTile(
                  onTap: () async {
                    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SessionDetailScreen(sessionId: s['id'] as String)));
                    await reload();
                  },
                  leading: CircleAvatar(child: Text(initials((s['customer'] as Map)['name'] as String))),
                  title: Text((s['customer'] as Map)['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${(s['service'] as Map)['name']} · ${(s['therapist'] as Map)['name']}${started != null ? ' · ${timeLabel('${started.hour}:${started.minute.toString().padLeft(2, '0')}')}' : ''}'),
                  trailing: StatusChip(s['status'] as String),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
