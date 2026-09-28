import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';
import 'customer_app.dart';
import 'customer_session.dart';

/// Nearby centres; each one can be called, navigated to or booked.
class BookScreen extends StatefulWidget {
  const BookScreen({super.key});

  @override
  State<BookScreen> createState() => _BookScreenState();
}

class _BookScreenState extends State<BookScreen> {
  Position? _position;
  String? _locationNote;
  final _view = GlobalKey<AsyncViewState<List<Map<String, dynamic>>>>();

  Future<void> _locate() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) throw ApiException('LOCATION', 'Turn on location services to find centres near you.');
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        throw ApiException('LOCATION', 'Allow location access to sort centres by distance.');
      }
      final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 15)));
      setState(() {
        _position = p;
        _locationNote = null;
      });
      await _view.currentState?.reload();
    } on ApiException catch (e) {
      setState(() => _locationNote = e.message);
    } catch (_) {
      setState(() => _locationNote = 'Could not get your location right now.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(title: const Text('Book a visit')),
      body: AsyncView<List<Map<String, dynamic>>>(
        key: _view,
        load: () async => ((await api.get('/portal/branches', query: {'lat': _position?.latitude, 'lng': _position?.longitude})) as List).cast<Map<String, dynamic>>(),
        builder: (context, branches, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: ListTile(
              leading: Icon(_position == null ? Icons.my_location : Icons.near_me, color: Theme.of(context).colorScheme.primary),
              title: Text(_position == null ? 'Find centres near me' : 'Sorted by distance from you'),
              subtitle: _locationNote != null ? Text(_locationNote!) : null,
              trailing: _position == null ? const Icon(Icons.chevron_right) : IconButton(tooltip: 'Refresh location', icon: const Icon(Icons.refresh), onPressed: _locate),
              onTap: _position == null ? _locate : null,
            ),
          ),
          const SectionTitle('Our centres'),
          if (branches.isEmpty) const EmptyState(icon: Icons.storefront_outlined, title: 'Online booking is not open yet', message: 'Please call the centre to book.'),
          ...branches.map((b) => _CentreCard(branch: b)),
        ]),
      ),
    );
  }
}

class _CentreCard extends StatelessWidget {
  const _CentreCard({required this.branch});
  final Map<String, dynamic> branch;

  @override
  Widget build(BuildContext context) {
    final b = branch;
    final phone = b['phone'] as String?;
    final lat = b['latitude'] as num?;
    final lng = b['longitude'] as num?;
    final km = b['distanceKm'] as num?;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(b['name'] as String, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
              if (km != null) Text(km < 1 ? '${(km * 1000).round()} m' : '${km.toStringAsFixed(1)} km', style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.w600)),
            ]),
            const SizedBox(height: 4),
            Text([b['address'], b['city']].whereType<String>().join(', '), style: TextStyle(color: Colors.grey.shade700)),
            if (b['openingTime'] != null) Text('Open ${timeLabel(b['openingTime'] as String)} – ${timeLabel(b['closingTime'] as String)}', style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
            const SizedBox(height: 12),
            Row(children: [
              if (phone != null) IconButton.outlined(tooltip: 'Call', onPressed: () => launchUrl(Uri(scheme: 'tel', path: phone)), icon: const Icon(Icons.call_outlined)),
              if (lat != null && lng != null) ...[
                const SizedBox(width: 8),
                IconButton.outlined(
                  tooltip: 'Directions',
                  onPressed: () => launchUrl(Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$lat,$lng'), mode: LaunchMode.externalApplication),
                  icon: const Icon(Icons.directions_outlined),
                ),
              ],
              const Spacer(),
              FilledButton.icon(
                onPressed: () async {
                  final booked = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => BookingFlowScreen(branch: b)));
                  if (booked == true && context.mounted) CustomerHome.of(context)?.go(CustomerHomeState.visits);
                },
                icon: const Icon(Icons.event_available, size: 18),
                label: const Text('Book here'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// Service → date → time (and optionally therapist) → confirm.
class BookingFlowScreen extends StatefulWidget {
  const BookingFlowScreen({super.key, required this.branch});
  final Map<String, dynamic> branch;

  @override
  State<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends State<BookingFlowScreen> {
  Map<String, dynamic>? _catalog;
  Object? _error;
  Map<String, dynamic>? _service;
  late String _date;
  Map<String, dynamic>? _slots;
  bool _loadingSlots = false;
  String? _time;
  String? _therapistId;
  final _notes = TextEditingController();

  ApiClient get _api => context.read<ApiClient>();
  String get _branchId => widget.branch['id'] as String;

  @override
  void initState() {
    super.initState();
    _date = isoDate(DateTime.now());
    _loadCatalog();
  }

  Future<void> _loadCatalog() async {
    try {
      final c = await _api.get('/portal/catalog') as Map<String, dynamic>;
      setState(() {
        _catalog = c;
        _date = c['today'] as String;
        _error = null;
      });
    } catch (e) {
      setState(() => _error = e);
    }
  }

  List<Map<String, dynamic>> get _services => ((_catalog?['services'] as List?) ?? const [])
      .cast<Map<String, dynamic>>()
      .where((s) => (s['branches'] as List).any((b) => (b as Map)['branchId'] == _branchId))
      .toList();

  Map<String, dynamic>? _offer(Map<String, dynamic> s) => (s['branches'] as List).cast<Map<String, dynamic>>().where((b) => b['branchId'] == _branchId).firstOrNull;

  Future<void> _loadSlots() async {
    final service = _service;
    if (service == null) return;
    setState(() {
      _loadingSlots = true;
      _time = null;
      _therapistId = null;
    });
    try {
      final s = await _api.get('/portal/slots', query: {'branchId': _branchId, 'serviceId': service['id'], 'date': _date}) as Map<String, dynamic>;
      if (mounted) setState(() => _slots = s);
    } catch (e) {
      if (mounted) {
        setState(() => _slots = null);
        showError(context, e);
      }
    } finally {
      if (mounted) setState(() => _loadingSlots = false);
    }
  }

  List<DateTime> get _days {
    final today = DateTime.parse(_catalog?['today'] as String? ?? isoDate(DateTime.now()));
    final max = DateTime.tryParse(_catalog?['maxDate'] as String? ?? '') ?? today.add(const Duration(days: 30));
    final count = (max.difference(today).inDays + 1).clamp(1, 30);
    return List.generate(count, (i) => today.add(Duration(days: i)));
  }

  Future<void> _confirm() async {
    final currency = context.read<CustomerSession>().currency;
    final service = _service!;
    final therapists = ((_slots?['therapists'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final therapist = therapists.where((t) => t['id'] == _therapistId).firstOrNull;
    final ok = await confirm(
      context,
      title: 'Confirm booking',
      message: '${service['name']}\n${dayLabel(_date)} at ${timeLabel(_time!)}\n${widget.branch['name']}${therapist != null ? '\nwith ${therapist['name']}' : ''}\n${money(_slots?['price'] as num?, currency: currency)} · pay at the centre',
      action: 'Book',
    );
    if (!ok) return;
    await _api.post('/portal/appointments', {
      'branchId': _branchId,
      'serviceId': service['id'],
      'therapistId': ?_therapistId,
      'date': _date,
      'startTime': _time,
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
    });
    if (!mounted) return;
    showInfo(context, 'Booked! See you ${dayLabel(_date).toLowerCase() == 'today' ? 'today' : 'on ${dayLabel(_date)}'}.');
    Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final currency = context.watch<CustomerSession>().currency;
    return Scaffold(
      appBar: AppBar(title: Text(widget.branch['name'] as String)),
      body: _catalog == null
          ? (_error != null ? ErrorView(error: _error!, onRetry: _loadCatalog) : const Center(child: CircularProgressIndicator()))
          : ListView(padding: const EdgeInsets.all(16), children: [
              const SectionTitle('1. Choose a service'),
              if (_services.isEmpty) const EmptyState(icon: Icons.spa_outlined, title: 'No services bookable here online'),
              ..._services.map((s) {
                final offer = _offer(s);
                final selected = _service?['id'] == s['id'];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Card(
                    shape: selected ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: Theme.of(context).colorScheme.primary, width: 2)) : null,
                    child: ListTile(
                      onTap: () {
                        setState(() => _service = s);
                        _loadSlots();
                      },
                      title: Text(s['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text([(s['category'] as Map?)?['name'], '${offer?['durationMinutes'] ?? s['durationMinutes']} min'].whereType<Object>().join(' · ')),
                      trailing: Text(money(offer?['price'] as num? ?? s['price'] as num?, currency: currency), style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                  ),
                );
              }),
              if (_service != null) ...[
                const SectionTitle('2. Pick a day'),
                SizedBox(
                  height: 64,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: _days.map((d) {
                      final iso = isoDate(d);
                      return Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          selected: iso == _date,
                          label: Column(mainAxisSize: MainAxisSize.min, children: [Text(dayLabel(iso).split(',').first), Text('${d.day}', style: const TextStyle(fontWeight: FontWeight.w700))]),
                          onSelected: (_) {
                            setState(() => _date = iso);
                            _loadSlots();
                          },
                        ),
                      );
                    }).toList(),
                  ),
                ),
                const SectionTitle('3. Choose a time'),
                if (_loadingSlots)
                  const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
                else if (((_slots?['slots'] as List?) ?? const []).isEmpty)
                  const EmptyState(icon: Icons.event_busy_outlined, title: 'Fully booked', message: 'Try another day.')
                else
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: (_slots!['slots'] as List).cast<Map<String, dynamic>>().map((slot) {
                      final t = slot['time'] as String;
                      return ChoiceChip(
                        label: Text(timeLabel(t)),
                        selected: _time == t,
                        onSelected: (_) => setState(() {
                          _time = t;
                          if (_therapistId != null && !(slot['therapistIds'] as List).contains(_therapistId)) _therapistId = null;
                        }),
                      );
                    }).toList(),
                  ),
                if (_time != null) ...[
                  const SectionTitle('4. Therapist (optional)'),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    ChoiceChip(label: const Text('No preference'), selected: _therapistId == null, onSelected: (_) => setState(() => _therapistId = null)),
                    ..._availableTherapists().map((t) => ChoiceChip(label: Text(t['name'] as String), selected: _therapistId == t['id'], onSelected: (_) => setState(() => _therapistId = t['id'] as String))),
                  ]),
                  const SizedBox(height: 16),
                  TextField(controller: _notes, maxLines: 2, decoration: const InputDecoration(labelText: 'Anything we should know? (optional)')),
                  const SizedBox(height: 20),
                  BusyButton(label: 'Review & book', icon: Icons.check, onPressed: _confirm),
                ],
              ],
              const SizedBox(height: 32),
            ]),
    );
  }

  List<Map<String, dynamic>> _availableTherapists() {
    final slot = ((_slots?['slots'] as List?) ?? const []).cast<Map<String, dynamic>>().where((s) => s['time'] == _time).firstOrNull;
    final ids = ((slot?['therapistIds'] as List?) ?? const []).toSet();
    return ((_slots?['therapists'] as List?) ?? const []).cast<Map<String, dynamic>>().where((t) => ids.contains(t['id'])).toList();
  }
}
