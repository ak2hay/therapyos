import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'branch_picker.dart';
import 'staff_session.dart';

/// Walk-in queue for the selected branch: waiting customers, therapist availability and upcoming bookings.
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key});

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  final _view = GlobalKey<AsyncViewState<Map<String, dynamic>>>();

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    final staff = context.watch<StaffSession>();
    final branchId = staff.branchId;
    final manage = staff.can('queue.manage');
    return Scaffold(
      appBar: AppBar(title: const Text('Queue'), actions: const [BranchPicker()]),
      floatingActionButton: manage && branchId != null
          ? FloatingActionButton.extended(
              onPressed: () async {
                final added = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => _WalkInSheet(api: api, branchId: branchId));
                if (added == true) await _view.currentState?.reload();
              },
              icon: const Icon(Icons.person_add_alt),
              label: const Text('Walk-in'),
            )
          : null,
      body: branchId == null
          ? const EmptyState(icon: Icons.storefront_outlined, title: 'No branch assigned', message: 'Ask your manager to give you access to a branch.')
          : AsyncView<Map<String, dynamic>>(
              key: _view,
              refreshInterval: const Duration(seconds: 15),
              load: () async => await api.get('/queue', query: {'branchId': branchId}) as Map<String, dynamic>,
              builder: (context, board, reload) => _Board(board: board, reload: reload, manage: manage, api: api),
            ),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final branchId = context.read<StaffSession>().branchId;
    if (_branch != null && _branch != branchId) WidgetsBinding.instance.addPostFrameCallback((_) => _view.currentState?.reload());
    _branch = branchId;
  }

  String? _branch;
}

class _Board extends StatelessWidget {
  const _Board({required this.board, required this.reload, required this.manage, required this.api});
  final Map<String, dynamic> board;
  final Future<void> Function() reload;
  final bool manage;
  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    final stats = board['stats'] as Map<String, dynamic>;
    final entries = (board['entries'] as List).cast<Map<String, dynamic>>();
    final therapists = (board['therapists'] as List).cast<Map<String, dynamic>>();
    final upcoming = (board['upcoming'] as List).cast<Map<String, dynamic>>();
    final active = entries.where((e) => ['WAITING', 'CALLED', 'ASSIGNED', 'IN_SERVICE'].contains(e['status'])).toList();
    final finished = entries.length - active.length;

    Future<void> act(Future<dynamic> Function() call, [String? success]) async {
      final res = await call();
      if (res is Map && res['warning'] is String && context.mounted) showInfo(context, res['warning'] as String);
      if (success != null && context.mounted) showInfo(context, success);
      await reload();
    }

    return ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 96), children: [
      Row(children: [
        Expanded(child: StatTile(label: 'Waiting', value: '${stats['waiting']}', icon: Icons.hourglass_top)),
        const SizedBox(width: 10),
        Expanded(child: StatTile(label: 'In service', value: '${stats['inService']}', icon: Icons.spa_outlined)),
        const SizedBox(width: 10),
        Expanded(child: StatTile(label: 'Avg wait', value: '${stats['avgWaitMinutes']}m', icon: Icons.timer_outlined)),
      ]),
      SectionTitle('In line', trailing: finished > 0 ? Text('$finished done today', style: TextStyle(color: Colors.grey.shade600, fontSize: 12)) : null),
      if (active.isEmpty) const EmptyState(icon: Icons.event_seat_outlined, title: 'Nobody waiting', message: 'Walk-ins and checked-in bookings show up here.'),
      ...active.map((e) => _EntryCard(entry: e, therapists: therapists, manage: manage, api: api, act: act)),
      SectionTitle('Therapists', trailing: Text('${stats['freeTherapists']} free', style: TextStyle(color: Colors.grey.shade600, fontSize: 12))),
      Card(
        child: Column(
          children: therapists.isEmpty
              ? [const ListTile(title: Text('No therapists on the roster today'))]
              : therapists.map((t) {
                  final s = t['session'] as Map<String, dynamic>?;
                  final end = parseDate(s?['expectedEnd']);
                  return ListTile(
                    dense: true,
                    leading: CircleAvatar(radius: 16, child: Text(initials(t['name'] as String), style: const TextStyle(fontSize: 12))),
                    title: Text(t['name'] as String),
                    subtitle: s == null ? null : Text('${s['customer']} · ${s['service']}${end != null ? ' · until ${timeLabel('${end.hour}:${end.minute.toString().padLeft(2, '0')}')}' : ''}'),
                    trailing: StatusChip(t['state'] as String),
                  );
                }).toList(),
        ),
      ),
      if (upcoming.isNotEmpty) ...[
        const SectionTitle('Upcoming bookings'),
        ...upcoming.map((a) => Card(
              child: ListTile(
                leading: Text(timeLabel(a['localTime'] as String), style: const TextStyle(fontWeight: FontWeight.w600)),
                title: Text((a['customer'] as Map)['name'] as String),
                subtitle: Text('${(a['service'] as Map)['name']} · ${(a['therapist'] as Map?)?['name'] ?? 'Any therapist'}'),
                trailing: manage
                    ? SizedBox(
                        height: 36,
                        child: BusyButton(label: 'Check in', outlined: true, onPressed: () => act(() => api.post('/appointments/${a['id']}/check-in'), 'Checked in')),
                      )
                    : null,
              ),
            )),
      ],
    ]);
  }
}

class _EntryCard extends StatelessWidget {
  const _EntryCard({required this.entry, required this.therapists, required this.manage, required this.api, required this.act});
  final Map<String, dynamic> entry;
  final List<Map<String, dynamic>> therapists;
  final bool manage;
  final ApiClient api;
  final Future<void> Function(Future<dynamic> Function() call, [String? success]) act;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final id = e['id'] as String;
    final status = e['status'] as String;
    final service = e['service'] as Map<String, dynamic>?;
    final therapist = e['therapist'] as Map<String, dynamic>?;
    final staff = context.read<StaffSession>();

    Future<void> assign() async {
      final picked = await showModalBottomSheet<String>(
        context: context,
        builder: (ctx) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            const ListTile(title: Text('Assign therapist', style: TextStyle(fontWeight: FontWeight.w600))),
            ...therapists.where((t) => t['state'] != 'OFF_SHIFT').map((t) => ListTile(
                  title: Text(t['name'] as String),
                  trailing: StatusChip(t['state'] as String),
                  onTap: () => Navigator.pop(ctx, t['id'] as String),
                )),
          ]),
        ),
      );
      if (picked != null) await act(() => api.post('/queue/$id/assign', {'therapistId': picked}), 'Therapist assigned');
    }

    final actions = <Widget>[
      if (manage && status == 'WAITING') BusyButton(label: 'Call', outlined: true, onPressed: () => act(() => api.post('/queue/$id/call'))),
      if (manage && ['WAITING', 'CALLED', 'ASSIGNED'].contains(status)) BusyButton(label: therapist == null ? 'Assign' : 'Reassign', outlined: true, onPressed: assign),
      if (manage && staff.can('session.manage') && ['CALLED', 'ASSIGNED'].contains(status) && therapist != null && service != null)
        BusyButton(label: 'Start', icon: Icons.play_arrow, onPressed: () => act(() => api.post('/queue/$id/start'), 'Session started')),
      if (manage && staff.can('session.manage') && status == 'IN_SERVICE')
        BusyButton(label: 'Complete', icon: Icons.check, color: Colors.green.shade700, onPressed: () => act(() => api.post('/queue/$id/complete'), 'Completed')),
    ];

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              CircleAvatar(radius: 18, child: Text('${e['queueNumber']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text((e['customer'] as Map)['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text(
                    [service?['name'] ?? 'Service not chosen', if (therapist != null) therapist['name'], '${e['waitingMinutes']} min ${status == 'IN_SERVICE' ? 'waited' : 'waiting'}'].join(' · '),
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                  ),
                ]),
              ),
              StatusChip(status),
              if (manage && status != 'IN_SERVICE')
                PopupMenuButton<String>(
                  tooltip: 'More',
                  onSelected: (_) async {
                    if (await confirm(context, title: 'Remove from queue?', message: '${(e['customer'] as Map)['name']} will be taken off the queue.', action: 'Remove', destructive: true)) {
                      try {
                        await act(() => api.post('/queue/$id/cancel'), 'Removed from queue');
                      } catch (err) {
                        if (context.mounted) showError(context, err);
                      }
                    }
                  },
                  itemBuilder: (_) => const [PopupMenuItem(value: 'cancel', child: Text('Remove from queue'))],
                ),
            ]),
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, children: actions.map((a) => SizedBox(height: 36, child: a)).toList()),
            ],
          ]),
        ),
      ),
    );
  }
}

class _WalkInSheet extends StatefulWidget {
  const _WalkInSheet({required this.api, required this.branchId});
  final ApiClient api;
  final String branchId;

  @override
  State<_WalkInSheet> createState() => _WalkInSheetState();
}

class _WalkInSheetState extends State<_WalkInSheet> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  String? _serviceId;
  List<Map<String, dynamic>> _services = const [];

  @override
  void initState() {
    super.initState();
    widget.api.page('/services', query: {'branchId': widget.branchId, 'pageSize': 100, 'status': 'ACTIVE'}).then((p) {
      if (mounted) setState(() => _services = p.items);
    }).catchError((_) {});
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    await widget.api.post('/queue', {
      'branchId': widget.branchId,
      'customer': {'name': _name.text.trim(), 'phone': _phone.text.trim()},
      'serviceId': ?_serviceId,
    });
    if (mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: Form(
        key: _form,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Add walk-in', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 16),
          TextFormField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Customer name'),
            textCapitalization: TextCapitalization.words,
            validator: (v) => (v ?? '').trim().length < 2 ? 'Enter the customer name' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _phone,
            decoration: const InputDecoration(labelText: 'Phone number', hintText: '98450 12345'),
            keyboardType: TextInputType.phone,
            validator: (v) => (v ?? '').replaceAll(RegExp(r'\D'), '').length < 10 ? 'Enter a valid phone number' : null,
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _serviceId,
            decoration: const InputDecoration(labelText: 'Service (optional)'),
            items: _services.map((s) => DropdownMenuItem(value: s['id'] as String, child: Text(s['name'] as String))).toList(),
            onChanged: (v) => setState(() => _serviceId = v),
          ),
          const SizedBox(height: 20),
          BusyButton(label: 'Add to queue', icon: Icons.add, onPressed: _submit),
        ]),
      ),
    );
  }
}
